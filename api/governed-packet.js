import { requireSession } from '../lib/auth.js';
import { approveRequest, authorizeConfiguredDestination, GovernanceError, packetRuntimeDiagnostics } from '../lib/governance.js';
import { getInfrastructure } from '../lib/infrastructure.js';
import { LIFETIMES_MS } from '../lib/controlPlanePolicy.js';
import { safeErrorCode,safeErrorStatus } from '../lib/safeErrors.js';
import { workerOperationalLog } from '../lib/workerOperationalLog.js';
export function governedPacketHandler(repository,redis){return async function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if (!requireSession(req)) return res.status(401).json({error:'AUTHENTICATION_REQUIRED'});
  try { const p=approveRequest(req.body);authorizeConfiguredDestination(p.stage,p.provider,p.model,p.settings,process.env); const run=await repository.getRun(p.run_id);if(!run||run.state!=='active'||Date.now()>=new Date(run.effective_expires_at).getTime())throw new GovernanceError('RUN_INACTIVE',409);
    const serialized=JSON.stringify(p);const staged=await redis.stagePacket({runId:p.run_id,packetId:p.packet_id,body:serialized,deadline:run.absolute_deadline_at,ttlMs:LIFETIMES_MS.packet});if(staged!==1)throw new GovernanceError('DEPENDENCY_UNAVAILABLE',503);
    const partCount=p.parts.length,charCount=p.parts.reduce((n,x)=>n+x.text.length,0)+p.system_instruction.length;
    const committed=await repository.commitPacket({packetId:p.packet_id,runId:p.run_id,packetHash:p.packet_hash,schemaVersion:p.schema_version,policyVersion:p.policy_version,classificationCode:p.residual_classification,provider:p.provider,model:p.model,stage:p.stage,partCount,charCount});if(!committed)throw new GovernanceError('RUN_INACTIVE',409);
    const active=await redis.activatePacket({runId:p.run_id,packetId:p.packet_id,deadline:run.absolute_deadline_at,ttlMs:LIFETIMES_MS.packet});if(active!==1)throw new GovernanceError('DEPENDENCY_UNAVAILABLE',503);
    workerOperationalLog('info','governed_packet_approved',{run_id:p.run_id,packet_id:p.packet_id,stage:p.stage,provider:p.provider,model:p.model,...packetRuntimeDiagnostics(p,serialized)});
    return res.status(201).json({schema_version:p.schema_version,policy_version:p.policy_version,packet_id:p.packet_id,packet_hash:p.packet_hash,run_id:p.run_id,stage:p.stage,provider:p.provider,model:p.model,...(p.output_contract?{output_contract:p.output_contract}:{}),classification_method:p.classification_method,approval_basis:p.approval_basis,created_at:p.created_at,expires_at:p.expires_at,part_count:partCount,char_count:charCount}); }
  catch(e) { const code=e instanceof GovernanceError?e.code:safeErrorCode(e); return res.status(e instanceof GovernanceError?e.status:safeErrorStatus(code)).json({error:code}); }
};}
export default async function handler(req,res){try{const {repository,redis}=getInfrastructure();return await governedPacketHandler(repository,redis)(req,res);}catch{return res.status(503).json({error:'VERCEL_GOVERNED_DISPATCH_UNSUPPORTED'});}}
