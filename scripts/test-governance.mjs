import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { approvedPacketBytes,approvedPacketHash,approveRequest,approveRequestArtifact,authorizeDestination,evaluatePacketBinding,inspectOutput,packetRuntimeDiagnostics,parseApprovedPacketBody,validateGovernedOutput,POLICY_VERSION,STAGE_PACKET_REQUEST_VERSION } from '../lib/governance.js';
import { OUTPUT_CONTRACT_IDS } from '../lib/outputContracts.js';
import { governedPacketHandler } from '../api/governed-packet.js';
import { issueCookie } from '../lib/auth.js';
const request={schema_version:STAGE_PACKET_REQUEST_VERSION,policy_version:POLICY_VERSION,run_id:'run-1',stage:'forensic_audit',provider:'anthropic',model:'claude-sonnet-5',destination:'anthropic:external_model',system_instruction:'Review safely',parts:[{type:'text',text:'monthly invoice review, EDP pricing policy, billing account governance'}],settings:{max_tokens:16384}};
assert.equal(approveRequest(request).approval_basis,'policy_approved_after_pattern_screening');
const undefinedOptionals=approveRequest({...request,settings:{...request.settings,reasoning_effort:undefined},output_contract:undefined},1000);
const persistedUndefinedOptionals=JSON.parse(JSON.stringify(undefinedOptionals));
assert.deepEqual(undefinedOptionals,persistedUndefinedOptionals,'approved packet must already equal its JSON-persisted representation');
assert.equal(approvedPacketHash(persistedUndefinedOptionals),undefinedOptionals.packet_hash,'packet hash must survive a JSON round trip');
const artifact=approveRequestArtifact(request,1000);
assert.ok(Buffer.isBuffer(artifact.canonicalBody));
assert.equal(approvedPacketHash(artifact.packet),artifact.packet.packet_hash);
assert.deepEqual(parseApprovedPacketBody(artifact.canonicalBody,artifact.packet.packet_hash),artifact.packet,'the authoritative bytes must reconstruct the approved packet');
assert.throws(()=>parseApprovedPacketBody(Buffer.from('{"corrupt":true}'),artifact.packet.packet_hash),error=>error.code==='PACKET_CONTENT_HASH_MISMATCH','stored bytes must be hashed before parsing');
const nestedShapes={...undefinedOptionals,packet_hash:undefined,output_contract:{schema:{optional:undefined,settings:[undefined,{limit:undefined},null]}}};
nestedShapes.packet_hash=approvedPacketHash(nestedShapes);
assert.equal(approvedPacketHash(JSON.parse(JSON.stringify(nestedShapes))),nestedShapes.packet_hash,'generic nested JSON-safe output contract shapes must hash consistently');
const securitySource=await readFile(new URL('../src/services/securityService.ts',import.meta.url),'utf8');assert.doesNotThrow(()=>approveRequest({...request,parts:[{type:'text',text:securitySource}]}));
for(const text of ['negotiated discount rate: 37%','contract value: $250000','billing account id: BA-12345','invoice number: INV-99887','SSN 123-45-6789','passport number: AB123456','home address: 12 Private Street'])assert.throws(()=>approveRequest({...request,parts:[{type:'text',text}]}),/RESIDUAL_CLASSIFICATION_REJECTED/);
for(const text of ['{"password":"hunter2"}','Format: CSV\nHeaders: contract value\nValues: $250000','{"invoice_number":"INV-99887"}'])assert.throws(()=>approveRequest({...request,parts:[{type:'text',text}]}),/SECRET_MATERIAL_REJECTED|RESIDUAL_CLASSIFICATION_REJECTED/);
assert.throws(()=>approveRequest({...request,system_instruction:'password=',parts:[{type:'text',text:'hunter2'}]}),/SECRET_MATERIAL_REJECTED/);
assert.throws(()=>approveRequest({...request,parts:[{type:'text',text:'data:image/png;base64,AAAA'}]}),/IMAGE_PAYLOAD_DISABLED/);
const packet=approveRequest(request,1000);const output=inspectOutput('Email a@b.com 😀 𝄞',packet,2000);assert.equal(output.text,'Email [REDACTED_EMAIL] 😀 𝄞');assert.equal(validateGovernedOutput(output,{source_packet_id:packet.packet_id}),output);
const expectedBinding={packetId:packet.packet_id,packetHash:packet.packet_hash,runId:packet.run_id,provider:packet.provider,model:packet.model,stage:packet.stage};
assert.equal(evaluatePacketBinding(packet,expectedBinding).code,null);
assert.equal(evaluatePacketBinding({...packet,packet_id:'different'},expectedBinding).code,'PACKET_ID_MISMATCH');
assert.equal(evaluatePacketBinding({...packet,packet_hash:'0'.repeat(64)},expectedBinding).code,'PACKET_HASH_METADATA_MISMATCH');
assert.equal(evaluatePacketBinding({...packet,system_instruction:'mutated'},expectedBinding).code,'PACKET_CONTENT_HASH_MISMATCH');
assert.equal(evaluatePacketBinding({...packet,hash_policy_version:'approved_packet_hash_v1'},expectedBinding).code,'PACKET_CONTENT_HASH_MISMATCH','hash-policy version skew must be detected as content skew');
for(const [field,expectedField,code,value] of [['run_id','runId','PACKET_RUN_MISMATCH','other-run'],['provider','provider','PACKET_PROVIDER_MISMATCH','xai'],['model','model','PACKET_MODEL_MISMATCH','other-model'],['stage','stage','PACKET_STAGE_MISMATCH','fact_check']]){const changed={...packet,[field]:value};changed.packet_hash=approvedPacketHash(changed);assert.equal(evaluatePacketBinding(changed,{...expectedBinding,packetHash:changed.packet_hash,[expectedField]:expectedBinding[expectedField]}).code,code);}
const diagnostics=packetRuntimeDiagnostics(packet,approvedPacketBytes(packet));assert.equal(diagnostics.declared_packet_hash,packet.packet_hash);assert.equal(diagnostics.recomputed_content_hash,packet.packet_hash);assert.equal(typeof diagnostics.serialized_bytes,'number');assert.doesNotMatch(JSON.stringify(diagnostics),/monthly invoice review|EDP pricing|billing account governance/);
for(const mutate of [o=>({...o,text:'changed'}),o=>({...o,source_packet_hash:'0'.repeat(64)}),o=>({...o,schema_version:'old'})])assert.throws(()=>validateGovernedOutput(mutate(output),{source_packet_hash:packet.packet_hash}),/INVALID_GOVERNED_OUTPUT/);
for(const text of ['password=[REDACTED:password]','data:image/png;base64,AAAA','contract value: $250000','invoice number: INV-99887','bad\uD800',''])assert.throws(()=>inspectOutput(text,packet),/OUTPUT_INSPECTION_REJECTED/);
assert.throws(()=>authorizeDestination('forensic_audit','anthropic','claude-sonnet-5',{max_tokens:1}),/INVALID_MODEL_SETTINGS/);
const xaiRequest={...request,provider:'xai',model:'grok-4.5',destination:'xai:external_model',system_instruction:'Return JSON only',settings:{max_tokens:16384,reasoning_effort:'medium'}};
assert.equal(approveRequest(xaiRequest).provider,'xai');
assert.throws(()=>authorizeDestination('forensic_audit','xai','grok-4.5',{max_tokens:4096,reasoning_effort:'medium'}),/INVALID_MODEL_SETTINGS/);
const synthesisRequest={...request,stage:'synthesis',output_contract:OUTPUT_CONTRACT_IDS.evidenceSynthesis};
assert.equal(approveRequest(synthesisRequest).output_contract,OUTPUT_CONTRACT_IDS.evidenceSynthesis);
assert.throws(()=>approveRequest({...synthesisRequest,stage:'roadmap_synthesis',settings:{max_tokens:32768}}),/OUTPUT_CONTRACT_NOT_AUTHORIZED/);
assert.throws(()=>approveRequest({...synthesisRequest,output_contract:'client_schema'}),/OUTPUT_CONTRACT_NOT_AUTHORIZED/);
let committedBody;const repository={getRun:async()=>({state:'active',effective_expires_at:new Date(Date.now()+60_000),absolute_deadline_at:new Date(Date.now()+60_000)}),commitPacket:async value=>{committedBody=value.canonicalBody;return true;}};
process.env.SECRET_KEY='test-secret-key-that-is-long-enough-123';
Object.assign(process.env,{
  REASONER_PROVIDER:'OPENAI',REASONER_MODEL:'gpt-5.6-sol',REASONER_FALLBACK_PROVIDER:'XAI',REASONER_FALLBACK_MODEL:'grok-4.5',
  WORKHORSE_PROVIDER:'ANTHROPIC',WORKHORSE_MODEL:'claude-sonnet-5',WORKHORSE_FALLBACK_PROVIDER:'XAI',WORKHORSE_FALLBACK_MODEL:'grok-4.5',
  QUALITY_CHECKER_PROVIDER:'XAI',QUALITY_CHECKER_MODEL:'grok-4.5',QUALITY_CHECKER_FALLBACK_PROVIDER:'ANTHROPIC',QUALITY_CHECKER_FALLBACK_MODEL:'claude-sonnet-5'
});
const req={method:'POST',headers:{cookie:issueCookie().split(';')[0]},body:synthesisRequest};
const res={status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
await governedPacketHandler(repository)(req,res);
assert.equal(res.statusCode,201);
assert.ok(Buffer.isBuffer(committedBody),'approval must atomically commit canonical bytes to PostgreSQL');
assert.equal(res.body.output_contract,OUTPUT_CONTRACT_IDS.evidenceSynthesis,'approval response must preserve the hash-bound output contract');
console.log('governance behavioral tests passed');
