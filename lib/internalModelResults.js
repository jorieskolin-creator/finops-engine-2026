import { validateGovernedOutput } from './governance.js';

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 200;
const results = new Map();
const now = () => Date.now();
function pruneExpired() {
  const cutoff=now()-TTL_MS;
  for(const [id,e] of results) if((e.updatedAt||e.createdAt||0)<cutoff) results.delete(id);
  while(results.size>MAX_ENTRIES) results.delete(results.keys().next().value);
}
function safeMetadata(m={}) { return { runId:m.runId||'',provider:m.provider||'',stage:m.stage||'',model:m.model||'',packetId:m.packetId||'',packetHash:m.packetHash||'' }; }
const expected = e => ({run_id:e.runId,stage:e.stage,provider:e.provider,model:e.model,source_packet_id:e.packetId,source_packet_hash:e.packetHash});
export function registerInternalModelResult(id,metadata={}) {
  if(typeof id!=='string'||!id) throw new Error('INVALID_INTERNAL_CALL_ID');
  pruneExpired(); if(results.has(id)) throw new Error('INTERNAL_CALL_ID_COLLISION');
  const ts=now(); results.set(id,{...safeMetadata(metadata),status:'pending',createdAt:ts,updatedAt:ts});
}
export function completeInternalModelResult(id,output,usage=null,metadata={}) {
  pruneExpired(); const entry=results.get(id); if(!entry||entry.status!=='pending') throw new Error('INTERNAL_CALL_NOT_RESERVED');
  const supplied=safeMetadata(metadata); if(Object.keys(supplied).some(k=>supplied[k]!==entry[k])) throw new Error('INTERNAL_RESULT_BINDING_MISMATCH');
  validateGovernedOutput(output,expected(entry));
  results.set(id,{...entry,status:'done',output,usage:usage||null,updatedAt:now()});
}
export function failInternalModelResult(id,message,metadata={}) {
  if(!id) return; pruneExpired(); const entry=results.get(id); if(!entry||entry.status!=='pending') return;
  const supplied=safeMetadata(metadata); if(Object.keys(supplied).some(k=>supplied[k]&&supplied[k]!==entry[k])) return;
  results.set(id,{...entry,status:'error',message:message||'model call failed',updatedAt:now()});
}
export function getInternalModelResult(id) {
  if(!id)return null; pruneExpired(); const e=results.get(id); if(!e)return null;
  if(e.status==='done') validateGovernedOutput(e.output,expected(e));
  return {...e};
}
export function clearInternalModelResultsForTests(){results.clear();}
