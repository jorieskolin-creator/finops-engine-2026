import { requireSession } from '../lib/auth.js';
import { approveRequest, GovernanceError } from '../lib/governance.js';
import { storeApprovedPacket } from '../lib/governedPacketStore.js';
export default async function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if (!requireSession(req)) return res.status(401).json({error:'AUTHENTICATION_REQUIRED'});
  try { const p=approveRequest(req.body); storeApprovedPacket(p); return res.status(201).json({schema_version:p.schema_version,policy_version:p.policy_version,packet_id:p.packet_id,packet_hash:p.packet_hash,run_id:p.run_id,stage:p.stage,provider:p.provider,model:p.model,classification_method:p.classification_method,approval_basis:p.approval_basis,created_at:p.created_at,expires_at:p.expires_at,part_count:p.parts.length,char_count:p.parts.reduce((n,x)=>n+x.text.length,0)+p.system_instruction.length}); }
  catch(e) { const x=e instanceof GovernanceError?e:new GovernanceError('GOVERNANCE_FAILURE',500); return res.status(x.status).json({error:x.code}); }
}
