import crypto from 'node:crypto';
import { CONTROL_PLANE_SCHEMA_VERSION } from './controlPlanePolicy.js';

const ATTEMPT_TRANSITIONS = {
  queued:['dispatch_intent','outcome_unknown','cancelled'], dispatch_intent:['send_authorized','fallback_allowed','outcome_unknown','cancelled'],
  send_authorized:['succeeded','fallback_allowed','outcome_unknown','result_unavailable'], outcome_unknown:['succeeded','result_unavailable'],
};
export class ControlPlaneError extends Error { constructor(code) { super(code); this.code = code; } }
export class ControlPlaneRepository {
  constructor(db) { if (!db?.query) throw new ControlPlaneError('DATABASE_ADAPTER_REQUIRED'); this.db=db; }
  async compatibilityCheck() {
    const r=await this.db.query('SELECT COALESCE(MAX(version), 0)::integer AS version FROM schema_versions');
    if (r.rows?.[0]?.version !== CONTROL_PLANE_SCHEMA_VERSION) throw new ControlPlaneError('SCHEMA_INCOMPATIBLE');
    const quality=await this.db.query("SELECT to_regclass('run_quality_snapshots') IS NOT NULL AS ready");
    if(!quality.rows?.[0]?.ready)throw new ControlPlaneError('SCHEMA_INCOMPATIBLE');
    return true;
  }
  async ready() { await this.db.query('SELECT 1 AS ready'); return this.compatibilityCheck(); }
  async createRun() {
    const id=crypto.randomUUID();
    const r=await this.db.query(`INSERT INTO runs(run_id,state,absolute_deadline_at,effective_expires_at)
      VALUES($1,'active',clock_timestamp()+interval '24 hours',LEAST(clock_timestamp()+interval '2 hours',clock_timestamp()+interval '24 hours'))
      RETURNING run_id,state,created_at,last_activity_at,absolute_deadline_at,effective_expires_at,cleanup_status`,[id]);
    return r.rows[0];
  }
  async getRun(id) { const r=await this.db.query('SELECT run_id,state,created_at,last_activity_at,absolute_deadline_at,effective_expires_at,terminal_at,cleanup_status,failure_code FROM runs WHERE run_id=$1',[id]); return r.rows[0]||null; }
  async touchRun(id) { const r=await this.db.query(`UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at) WHERE run_id=$1 AND state='active' AND clock_timestamp()<effective_expires_at RETURNING run_id,state,effective_expires_at`,[id]); return r.rows[0]||null; }
  async completeRunWithQuality(runId,q) {
    const fields=['schema_version','formula_version','extraction_completeness','evidence_coverage','evidence_density','provenance_integrity','kb_completeness','evidence_packet_status','knowledge_packet_status','acquisition_status','security_status','extraction_incomplete_count','weak_source_packet_count','kb_blocking_count','unresolved_provenance_count'];
    const client=this.db.connect?await this.db.connect():this.db;
    try { await client.query('BEGIN');
      const locked=await client.query('SELECT run_id,state FROM runs WHERE run_id=$1 FOR UPDATE',[runId]); const run=locked.rows[0];
      if(!run)throw new ControlPlaneError('RUN_NOT_FOUND');
      if(run.state==='completed'){
        const stored=(await client.query(`SELECT ${fields.join(',')} FROM run_quality_snapshots WHERE run_id=$1`,[runId])).rows[0];
        if(!stored||fields.some(field=>stored[field]!==q[field]))throw new ControlPlaneError('INVALID_RUN_TRANSITION');
      } else if(run.state==='active'){
        await client.query(`INSERT INTO run_quality_snapshots(run_id,${fields.join(',')}) VALUES($1,${fields.map((_,index)=>`$${index+2}`).join(',')})`,[runId,...fields.map(field=>q[field])]);
        await client.query("UPDATE runs SET state='completed',terminal_at=clock_timestamp(),cleanup_status=COALESCE(cleanup_status,'pending'),last_activity_at=clock_timestamp() WHERE run_id=$1",[runId]);
      } else throw new ControlPlaneError('INVALID_RUN_TRANSITION');
      const result=(await client.query('SELECT run_id,state,created_at,last_activity_at,absolute_deadline_at,effective_expires_at,terminal_at,cleanup_status,failure_code FROM runs WHERE run_id=$1',[runId])).rows[0];
      await client.query('COMMIT'); return result;
    } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release?.();}
  }
  async terminalRun(id,target,failureCode=null) {
    if (!['failed','deletion_requested'].includes(target)) throw new ControlPlaneError('INVALID_RUN_TRANSITION');
    const r=await this.db.query(`UPDATE runs SET state=CASE WHEN $2='deletion_requested' AND (cleanup_status='verified' OR state='deleted') THEN 'deleted' ELSE $2 END,terminal_at=COALESCE(terminal_at,clock_timestamp()),cleanup_status=COALESCE(cleanup_status,'pending'),failure_code=CASE WHEN $2='failed' THEN COALESCE(failure_code,$3) ELSE failure_code END,last_activity_at=CASE WHEN state='active' THEN clock_timestamp() ELSE last_activity_at END
      WHERE run_id=$1 AND (state='active' OR state=$2 OR ($2='deletion_requested' AND state IN ('completed','failed','expired','deletion_requested','deleted')))
      RETURNING run_id,state,created_at,last_activity_at,absolute_deadline_at,effective_expires_at,terminal_at,cleanup_status,failure_code`,[id,target,failureCode]);
    if (r.rows[0]) return r.rows[0];
    const existing=await this.getRun(id); if (!existing) throw new ControlPlaneError('RUN_NOT_FOUND');
    throw new ControlPlaneError('INVALID_RUN_TRANSITION');
  }
  async commitPacket(m) { const values=[m.packetId,m.runId,m.packetHash,m.schemaVersion,m.policyVersion,m.classificationCode,m.provider,m.model,m.stage,m.partCount,m.charCount]; const r=await this.db.query(`WITH active_run AS (
      UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at)
      WHERE run_id=$2 AND state='active' AND clock_timestamp()<effective_expires_at RETURNING absolute_deadline_at
    ) INSERT INTO governed_packet_metadata(packet_id,run_id,packet_hash,schema_version,policy_version,classification_code,provider,model,stage,state,part_count,char_count,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,$11,LEAST(clock_timestamp()+interval '30 minutes',absolute_deadline_at) FROM active_run
    ON CONFLICT(packet_id) DO NOTHING RETURNING *`,values); return r.rows[0]||null; }
  async claimPacketAndReserve(binding) {
    const {packetId,packetHash,runId,provider,model,stage,internalCallId}=binding;
    const client=await this.db.connect(); try { await client.query('BEGIN');
      const existing=await client.query('SELECT * FROM model_attempts WHERE internal_call_id=$1 FOR UPDATE',[internalCallId]);
      if(existing.rows[0]) { const x=existing.rows[0]; if(x.packet_id!==packetId||x.packet_hash!==packetHash||x.run_id!==runId||x.provider!==provider||x.model!==model||x.stage!==stage)throw new ControlPlaneError('INTERNAL_CALL_BINDING_MISMATCH'); await client.query('COMMIT'); return x; }
      const run=await client.query(`UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at) WHERE run_id=$1 AND state='active' AND clock_timestamp()<effective_expires_at RETURNING absolute_deadline_at`,[runId]);
      if(!run.rows[0]){await client.query('ROLLBACK');return null;}
      const p=await client.query(`UPDATE governed_packet_metadata SET state='claimed',claimed_at=clock_timestamp() WHERE packet_id=$1 AND packet_hash=$2 AND run_id=$3 AND provider=$4 AND model=$5 AND stage=$6 AND state='approved' AND clock_timestamp()<expires_at RETURNING *`,[packetId,packetHash,runId,provider,model,stage]);
      if (!p.rows[0]) { await client.query('ROLLBACK'); return null; } const x=p.rows[0]; const attemptId=crypto.randomUUID();
      const a=await client.query(`INSERT INTO model_attempts(attempt_id,internal_call_id,run_id,packet_id,packet_hash,provider,model,stage,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`,[attemptId,internalCallId,x.run_id,x.packet_id,x.packet_hash,x.provider,x.model,x.stage]);
      await client.query(`INSERT INTO dispatch_outbox(outbox_id,attempt_id,run_id,state) VALUES($1,$2,$3,'pending') ON CONFLICT(attempt_id) DO NOTHING`,[crypto.randomUUID(),a.rows[0].attempt_id,x.run_id]); await client.query('COMMIT'); return a.rows[0];
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); if(error instanceof ControlPlaneError)throw error; throw new ControlPlaneError('DATABASE_OPERATION_FAILED'); } finally { client.release(); }
  }
  async getAttemptByInternalCallId(id) { const r=await this.db.query('SELECT attempt_id,internal_call_id,run_id,packet_id,packet_hash,provider,model,stage,state,input_tokens,output_tokens,outcome_code,created_at,updated_at FROM model_attempts WHERE internal_call_id=$1',[id]); return r.rows[0]||null; }
  async getAttempt(id) { const r=await this.db.query(`SELECT a.*,r.state run_state,r.absolute_deadline_at,r.effective_expires_at,p.schema_version,p.policy_version,p.classification_code,p.expires_at packet_expires_at FROM model_attempts a JOIN runs r USING(run_id) JOIN governed_packet_metadata p USING(packet_id) WHERE attempt_id=$1`,[id]);return r.rows[0]||null; }
  async transitionAttempt(id,from,to,counts={}) { if(!ATTEMPT_TRANSITIONS[from]?.includes(to)) throw new ControlPlaneError('INVALID_ATTEMPT_TRANSITION'); const r=await this.db.query(`WITH changed AS (
      UPDATE model_attempts SET state=$3,input_tokens=COALESCE($4,input_tokens),output_tokens=COALESCE($5,output_tokens),outcome_code=COALESCE($6,outcome_code),updated_at=clock_timestamp() WHERE attempt_id=$1 AND state=$2 RETURNING *
    ), touched AS (
      UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at) FROM changed WHERE runs.run_id=changed.run_id AND runs.state='active' RETURNING runs.run_id
    ) SELECT * FROM changed`,[id,from,to,counts.inputTokens??null,counts.outputTokens??null,counts.outcomeCode??null]); return r.rows[0]||null; }
  async claimPendingOutbox(owner,limit=20) { const r=await this.db.query(`WITH picked AS (SELECT outbox_id FROM dispatch_outbox WHERE state='pending' OR (state='publishing' AND publish_lease_until<clock_timestamp()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE dispatch_outbox o SET state='publishing',publish_owner=$1,publish_lease_until=clock_timestamp()+interval '30 seconds',publish_attempts=publish_attempts+1 FROM picked WHERE o.outbox_id=picked.outbox_id RETURNING o.outbox_id,o.attempt_id,o.run_id`,[owner,limit]); return r.rows; }
  async markPublished(id,owner) { const r=await this.db.query(`UPDATE dispatch_outbox SET state='published',published_at=clock_timestamp(),publish_lease_until=NULL WHERE outbox_id=$1 AND state='publishing' AND publish_owner=$2 RETURNING outbox_id`,[id,owner]); return !!r.rows[0]; }
  async claimAttempt(id,owner,leaseSeconds=30){const r=await this.db.query(`UPDATE model_attempts SET lease_owner=$2,lease_token=lease_token+1,lease_until=clock_timestamp()+($3||' seconds')::interval,updated_at=clock_timestamp() WHERE attempt_id=$1 AND state IN ('queued','dispatch_intent') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,[id,owner,leaseSeconds]);return r.rows[0]||null;}
  async renewAttemptLease(id,owner,token,leaseSeconds=30){const r=await this.db.query(`UPDATE model_attempts SET lease_until=clock_timestamp()+($4||' seconds')::interval,updated_at=clock_timestamp() WHERE attempt_id=$1 AND lease_owner=$2 AND lease_token=$3 AND state='send_authorized' AND lease_until>=clock_timestamp() RETURNING attempt_id`,[id,owner,token,leaseSeconds]);return !!r.rows[0];}
  async authorizeAttempt(id,owner,token){const r=await this.db.query(`WITH changed AS (UPDATE model_attempts a SET state='send_authorized',send_authorized_at=clock_timestamp(),updated_at=clock_timestamp() FROM runs r WHERE a.attempt_id=$1 AND a.run_id=r.run_id AND a.state='dispatch_intent' AND a.lease_owner=$2 AND a.lease_token=$3 AND a.lease_until>=clock_timestamp() AND r.state='active' AND clock_timestamp()<r.effective_expires_at AND clock_timestamp()<r.absolute_deadline_at RETURNING a.*), touched AS (UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at) FROM changed WHERE runs.run_id=changed.run_id RETURNING runs.run_id) SELECT * FROM changed`,[id,owner,token]);return r.rows[0]||null;}
  async recoverSucceeded(id,counts={}){const r=await this.db.query(`WITH changed AS (UPDATE model_attempts SET state='succeeded',input_tokens=COALESCE($2,input_tokens),output_tokens=COALESCE($3,output_tokens),updated_at=clock_timestamp() WHERE attempt_id=$1 AND state IN ('send_authorized','outcome_unknown') RETURNING *), touched AS (UPDATE runs SET last_activity_at=clock_timestamp(),effective_expires_at=LEAST(clock_timestamp()+interval '2 hours',absolute_deadline_at) FROM changed WHERE runs.run_id=changed.run_id AND runs.state='active' RETURNING runs.run_id) SELECT * FROM changed`,[id,counts.inputTokens??null,counts.outputTokens??null]);return r.rows[0]||null;}
  async listReconciliationCandidates(limit=100){const r=await this.db.query(`SELECT a.*,r.absolute_deadline_at FROM model_attempts a JOIN runs r USING(run_id) WHERE (a.state IN ('dispatch_intent','send_authorized') AND a.lease_until<clock_timestamp()) OR (a.state='outcome_unknown' AND a.updated_at>clock_timestamp()-interval '30 minutes') ORDER BY CASE WHEN a.state='outcome_unknown' THEN 1 ELSE 0 END,a.updated_at LIMIT $1`,[limit]);return r.rows;}
  async reconcileStale(){await this.db.query(`UPDATE dispatch_outbox o SET state='pending',publish_owner=NULL,publish_lease_until=NULL FROM model_attempts a WHERE o.attempt_id=a.attempt_id AND o.state='published' AND a.state IN ('queued','dispatch_intent') AND o.published_at<clock_timestamp()-interval '30 seconds'`);}
  async claimCleanup(runId) { const id=crypto.randomUUID(); const r=await this.db.query(`WITH stale AS (
      UPDATE cleanup_attempts SET status='retryable_failure',evidence_code='CLEANUP_LEASE_EXPIRED' WHERE run_id=$1 AND status='in_progress' AND attempted_at<clock_timestamp()-interval '1 minute' RETURNING run_id
    ), claimed AS (
      UPDATE runs SET cleanup_status='in_progress' WHERE run_id=$1 AND (cleanup_status IN ('pending','retryable_failure') OR (cleanup_status='in_progress' AND EXISTS (SELECT 1 FROM stale))) RETURNING run_id
    ) INSERT INTO cleanup_attempts(cleanup_attempt_id,run_id,status) SELECT $2,run_id,'in_progress' FROM claimed RETURNING cleanup_attempt_id`,[runId,id]); return r.rows[0]?.cleanup_attempt_id||null; }
  async claimCleanupCandidates(limit=20){const r=await this.db.query(`SELECT run_id,absolute_deadline_at FROM runs WHERE cleanup_status IN ('pending','retryable_failure') OR (cleanup_status='in_progress' AND NOT EXISTS (SELECT 1 FROM cleanup_attempts c WHERE c.run_id=runs.run_id AND c.status='in_progress' AND c.attempted_at>=clock_timestamp()-interval '1 minute')) ORDER BY terminal_at LIMIT $1`,[limit]);const claimed=[];for(const row of r.rows){const id=await this.claimCleanup(row.run_id);if(id)claimed.push({...row,cleanup_attempt_id:id});}return claimed;}
  async expireRuns(limit=100){const r=await this.db.query(`WITH picked AS (SELECT run_id FROM runs WHERE state='active' AND (effective_expires_at<=clock_timestamp() OR absolute_deadline_at<=clock_timestamp()) ORDER BY effective_expires_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE runs r SET state='expired',terminal_at=clock_timestamp(),cleanup_status='pending' FROM picked WHERE r.run_id=picked.run_id RETURNING r.run_id`,[limit]);return r.rows;}
  async pruneMetadata(){const r=await this.db.query(`WITH old_runs AS (SELECT run_id FROM runs WHERE metadata_expires_at<clock_timestamp() AND state<>'active'), deleted_quality AS (DELETE FROM run_quality_snapshots USING old_runs WHERE run_quality_snapshots.run_id=old_runs.run_id), deleted_cleanup AS (DELETE FROM cleanup_attempts USING old_runs WHERE cleanup_attempts.run_id=old_runs.run_id), deleted_outbox AS (DELETE FROM dispatch_outbox USING old_runs WHERE dispatch_outbox.run_id=old_runs.run_id), deleted_attempts AS (DELETE FROM model_attempts USING old_runs WHERE model_attempts.run_id=old_runs.run_id), deleted_packets AS (DELETE FROM governed_packet_metadata USING old_runs WHERE governed_packet_metadata.run_id=old_runs.run_id) DELETE FROM runs USING old_runs WHERE runs.run_id=old_runs.run_id RETURNING runs.run_id`);return r.rowCount||0;}
  async recordCleanupEvidence(runId,attemptId,status,evidenceCode,keyCount) { if(!['verified','retryable_failure'].includes(status))throw new ControlPlaneError('INVALID_CLEANUP_TRANSITION'); const client=await this.db.connect();try{await client.query('BEGIN');const evidence=await client.query(`UPDATE cleanup_attempts SET status=$3,evidence_code=$4,key_count=$5,verified_at=CASE WHEN $3='verified' THEN clock_timestamp() END WHERE cleanup_attempt_id=$2 AND run_id=$1 AND status='in_progress' RETURNING run_id`,[runId,attemptId,status,evidenceCode,keyCount]);if(!evidence.rows[0]){await client.query('ROLLBACK');return this.getRun(runId);}const r=await client.query(`UPDATE runs SET cleanup_status=$2,state=CASE WHEN $2='verified' AND state='deletion_requested' THEN 'deleted' ELSE state END WHERE run_id=$1 AND cleanup_status='in_progress' RETURNING run_id,state,cleanup_status`,[runId,status]);if(!r.rows[0]){await client.query('ROLLBACK');return this.getRun(runId);}if(status==='verified')await client.query(`UPDATE governed_packet_metadata SET state=CASE (SELECT state FROM runs WHERE run_id=$1) WHEN 'completed' THEN 'completed' WHEN 'deleted' THEN 'deleted' WHEN 'expired' THEN 'expired' ELSE 'failed' END WHERE run_id=$1`,[runId]);await client.query('COMMIT');return r.rows[0];}catch{await client.query('ROLLBACK').catch(()=>{});throw new ControlPlaneError('DATABASE_OPERATION_FAILED');}finally{client.release();} }
  async close() { await this.db.end?.(); }
}
