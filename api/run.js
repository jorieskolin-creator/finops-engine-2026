import { requireSession } from '../lib/auth.js';
import { getInfrastructure } from '../lib/infrastructure.js';
import { safeErrorCode,safeErrorStatus } from '../lib/safeErrors.js';
import { RunLifecycleService } from '../lib/runLifecycleService.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALITY_KEYS=['schema_version','formula_version','extraction_completeness','evidence_coverage','evidence_density','provenance_integrity','kb_completeness','evidence_packet_status','knowledge_packet_status','acquisition_status','security_status','extraction_incomplete_count','weak_source_packet_count','kb_blocking_count','unresolved_provenance_count'];
export function validQualitySnapshot(q){if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).sort().join('|')!==[...QUALITY_KEYS].sort().join('|'))return false;const percentages=['extraction_completeness','evidence_coverage','evidence_density','provenance_integrity','kb_completeness'];const counts=['extraction_incomplete_count','weak_source_packet_count','kb_blocking_count','unresolved_provenance_count'];return q.schema_version==='acquisition_quality_snapshot_v1'&&q.formula_version==='acquisition_quality_formula_v1'&&percentages.every(k=>Number.isInteger(q[k])&&q[k]>=0&&q[k]<=100)&&counts.every(k=>Number.isInteger(q[k])&&q[k]>=0&&q[k]<=10000)&&['READY','NOT_READY'].includes(q.evidence_packet_status)&&['READY','NOT_READY'].includes(q.knowledge_packet_status)&&['READY','NOT_READY'].includes(q.acquisition_status)&&['PASS','WARN','BLOCK'].includes(q.security_status);}
export function createRunHandler(repository,redis){const lifecycle=redis?new RunLifecycleService({repository,redis}):null;return async function(req,res){
  if(!requireSession(req))return res.status(401).json({error:'AUTHENTICATION_REQUIRED'});
  if(!['GET','POST','DELETE'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try {
    const body=req.body||{}; const action=req.method==='GET'?'status':req.method==='DELETE'?'delete':body.action;
    let result;
    if(action==='create'&&req.method==='POST')result=await repository.createRun();
    else { const id=body.run_id||req.query?.run_id; if(typeof id!=='string'||!UUID.test(id))return res.status(400).json({error:'INVALID_REQUEST'});
      if(action==='status')result=await repository.getRun(id);
      else if(action==='complete'){if(!validQualitySnapshot(body.quality))return res.status(400).json({error:'INVALID_REQUEST'});result=await (lifecycle?lifecycle.completeWithQuality(id,body.quality):repository.completeRunWithQuality(id,body.quality));}
      else if(action==='fail')result=await (lifecycle?lifecycle.transition(id,'failed',typeof body.failure_code==='string'&&/^[A-Z0-9_]{1,64}$/.test(body.failure_code)?body.failure_code:'PIPELINE_FAILED'):repository.terminalRun(id,'failed','PIPELINE_FAILED'));
      else if(action==='delete')result=await (lifecycle?lifecycle.transition(id,'deletion_requested'):repository.terminalRun(id,'deletion_requested'));
      else return res.status(400).json({error:'INVALID_REQUEST'});
    }
    if(!result)return res.status(404).json({error:'RUN_NOT_FOUND'});
    return res.status(action==='create'?201:200).json(result);
  } catch(error){const code=safeErrorCode(error);return res.status(safeErrorStatus(code)).json({error:code});}
};}
export default async function handler(req,res){try{const {repository,redis}=getInfrastructure();return await createRunHandler(repository,redis)(req,res);}catch{return res.status(503).json({error:'VERCEL_GOVERNED_DISPATCH_UNSUPPORTED'});}}
