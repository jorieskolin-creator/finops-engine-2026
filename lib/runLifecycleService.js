const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class RunLifecycleService{
  constructor({repository,redis}){Object.assign(this,{repository,redis});}
  async cleanupClaim(runId,attemptId,deadline){try{const count=await this.redis.tombstone(runId,deadline);return await this.repository.recordCleanupEvidence(runId,attemptId,'verified','REDIS_TOMBSTONE_VERIFIED',count);}catch{await this.repository.recordCleanupEvidence(runId,attemptId,'retryable_failure','REDIS_CLEANUP_RETRYABLE',0);throw Object.assign(new Error('cleanup'),{code:'DEPENDENCY_UNAVAILABLE'});}}
  async transition(runId,target,failureCode){const run=await this.repository.terminalRun(runId,target,failureCode);if(run.cleanup_status==='verified')return run;const attempt=await this.repository.claimCleanup(runId);if(!attempt)return await this.repository.getRun(runId);return this.cleanupClaim(runId,attempt,run.absolute_deadline_at);}
}
export class CleanupWorker{
  constructor({repository,redis,intervalMs=10_000}){Object.assign(this,{repository,redis,intervalMs});this.service=new RunLifecycleService({repository,redis});this.stopped=true;}
  async tick(){await this.repository.expireRuns();for(const row of await this.repository.claimCleanupCandidates())await this.service.cleanupClaim(row.run_id,row.cleanup_attempt_id,row.absolute_deadline_at).catch(()=>{});await this.redis.trimAttempts?.(Date.now()-24*60*60_000);await this.repository.pruneMetadata();}
  start(){if(!this.stopped)return;this.stopped=false;this.promise=this.loop();}async loop(){while(!this.stopped){try{await this.tick();}catch{}if(!this.stopped)await sleep(this.intervalMs);}}async stop(){this.stopped=true;await this.promise;}
}
