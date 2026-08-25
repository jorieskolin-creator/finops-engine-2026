import crypto from 'node:crypto';
import { requireSession } from '../lib/auth.js';
import { getInfrastructure } from '../lib/infrastructure.js';
import { inspectOutput,sha256 } from '../lib/governance.js';
import { LIFETIMES_MS } from '../lib/controlPlanePolicy.js';
import { safeErrorCode,safeErrorStatus } from '../lib/safeErrors.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[0-9a-f]{64}$/;
const KINDS=new Set(['acquisition','phase1','phase2','synthesis','fact_check','quality_gate','final_report']);
const PAYLOAD_KEYS={acquisition:['source_registry_status','privacy_decision','integrity','source_parse_warnings'],phase1:['phase_1_audit_logs','evidence_check','validation'],phase2:['phase_2_validation','maturity_model_shadow'],synthesis:['phase_3_strategy'],fact_check:['fact_check'],quality_gate:['quality_gate','phase_3_strategy'],final_report:['result']};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const unavailable=res=>res.status(503).json({error:'RESULT_UNAVAILABLE'});
export function checkpointHandler(repository,redis){return async(req,res)=>{
  if(!['POST','GET'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if(!requireSession(req))return res.status(401).json({error:'AUTHENTICATION_REQUIRED'});
  try{
    if(req.method==='POST'){
      const body=req.body;const keys=body?.parent_hash===undefined?['run_id','kind','scope','payload']:['run_id','kind','scope','payload','parent_hash'];
      if(!exact(body,keys)||typeof body.run_id!=='string'||!UUID.test(body.run_id)||typeof body.kind!=='string'||!KINDS.has(body.kind)||typeof body.scope!=='string'||!IDENT.test(body.scope)||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)||(body.parent_hash!==undefined&&(typeof body.parent_hash!=='string'||!HASH.test(body.parent_hash))))return res.status(400).json({error:'INVALID_REQUEST'});
      if(!exact(body.payload,PAYLOAD_KEYS[body.kind])||Object.values(body.payload).some(value=>value===undefined))return res.status(400).json({error:'INVALID_REQUEST'});
      const raw=JSON.stringify(body.payload);if(!raw||raw.length>1572864)return res.status(400).json({error:'INVALID_REQUEST'});
      const inspected=inspectOutput(raw,{packet_id:'checkpoint',packet_hash:'checkpoint',run_id:body.run_id,stage:body.kind,provider:'internal',model:'checkpoint'}).text;
      if(inspected.length>1572864)return res.status(400).json({error:'INVALID_REQUEST'});
      const run=await repository.getRun(body.run_id);if(!run)return res.status(404).json({error:'RUN_NOT_FOUND'});if(!['active','recovery_required'].includes(run.state)||Date.now()>=new Date(run.effective_expires_at).getTime()||Date.now()>=new Date(run.absolute_deadline_at).getTime())return res.status(409).json({error:'RUN_INACTIVE'});
      const checkpointId=crypto.randomUUID();const stored=await redis.setCheckpoint({runId:body.run_id,id:checkpointId,value:inspected,deadline:run.absolute_deadline_at,ttlMs:LIFETIMES_MS.checkpoint});if(stored!==1)return unavailable(res);
      let metadata;try{metadata=await repository.commitCheckpoint({checkpointId,runId:body.run_id,kind:body.kind,scope:body.scope,schemaVersion:'checkpoint_v1',payloadHash:sha256(inspected),charCount:inspected.length,parentHash:body.parent_hash});}catch(error){await redis.removeCheckpoint(body.run_id,checkpointId).catch(()=>{});throw error;}
      if(!metadata){await redis.removeCheckpoint(body.run_id,checkpointId).catch(()=>{});return res.status(409).json({error:'RUN_INACTIVE'});}
      return res.status(201).json(metadata);
    }
    const query=req.query||{};const keys=query.checkpoint_id===undefined?['run_id']:['run_id','checkpoint_id'];
    if(!exact(query,keys)||typeof query.run_id!=='string'||!UUID.test(query.run_id)||(query.checkpoint_id!==undefined&&(typeof query.checkpoint_id!=='string'||!UUID.test(query.checkpoint_id))))return res.status(400).json({error:'INVALID_REQUEST'});
    const run=await repository.getRun(query.run_id);if(!run)return res.status(404).json({error:'RUN_NOT_FOUND'});
    if(!query.checkpoint_id)return res.status(200).json({checkpoints:await repository.listCheckpoints(query.run_id)});
    const metadata=await repository.getCheckpoint(query.run_id,query.checkpoint_id);if(!metadata)return res.status(404).json({error:'RESULT_UNAVAILABLE'});
    const inspected=await redis.getCheckpoint(query.run_id,query.checkpoint_id);if(!inspected||sha256(inspected)!==metadata.payload_hash)return unavailable(res);
    let payload;try{payload=JSON.parse(inspected);}catch{return unavailable(res);}
    return res.status(200).json({metadata,payload});
  }catch(error){const code=safeErrorCode(error);return res.status(safeErrorStatus(code)).json({error:code});}
};}
export default async function handler(req,res){try{const {repository,redis}=getInfrastructure();return await checkpointHandler(repository,redis)(req,res);}catch{return res.status(503).json({error:'VERCEL_GOVERNED_DISPATCH_UNSUPPORTED'});}}
