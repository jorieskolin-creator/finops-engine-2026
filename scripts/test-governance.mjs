import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { approveRequest, authorizeDestination, inspectOutput, POLICY_VERSION, STAGE_PACKET_REQUEST_VERSION } from '../lib/governance.js';
import { claimApprovedPacket, resetPacketStoreForTests, setPacketStoreClockForTests, storeApprovedPacket } from '../lib/governedPacketStore.js';
import { clearInternalModelResultsForTests, getInternalModelResult, registerInternalModelResult } from '../lib/internalModelResults.js';
import { providerHandler } from '../lib/providerGateway.js';
import { issueCookie } from '../lib/auth.js';
import { readFile } from 'node:fs/promises';

const request={schema_version:STAGE_PACKET_REQUEST_VERSION,policy_version:POLICY_VERSION,run_id:'run-1',stage:'preflight',provider:'openai',model:'gpt-5.5',destination:'openai:external_model',system_instruction:'Review safely',parts:[{type:'text',text:'monthly invoice review, EDP pricing policy, billing account governance'}],settings:{max_tokens:4096,reasoning_effort:'low'}};
assert.equal(approveRequest(request).approval_basis,'policy_approved_after_pattern_screening');
const securitySource=await readFile(new URL('../src/services/securityService.ts',import.meta.url),'utf8');
assert.doesNotThrow(()=>approveRequest({...request,parts:[{type:'text',text:securitySource}]}),'real preflight prompt must pass');
for(const text of ['negotiated discount rate: 37%','contract value: $250000','billing account id: BA-12345','invoice number: INV-99887']) assert.throws(()=>approveRequest({...request,parts:[{type:'text',text}]}),/RESIDUAL_CLASSIFICATION_REJECTED/);
for(const text of ['{"password":"hunter2"}','Format: CSV\nHeaders: contract value\nValues: $250000','{"invoice_number":"INV-99887"}']) assert.throws(()=>approveRequest({...request,parts:[{type:'text',text}]}),/SECRET_MATERIAL_REJECTED|RESIDUAL_CLASSIFICATION_REJECTED/);
assert.throws(()=>approveRequest({...request,system_instruction:'password=',parts:[{type:'text',text:'hunter2'}]}),/SECRET_MATERIAL_REJECTED/);
assert.throws(()=>approveRequest({...request,parts:[{type:'text',text:'one'},{type:'text',text:'two'}]}),/INVALID_PARTS/);
assert.throws(()=>approveRequest({...request,parts:[{type:'text',text:'data:image/png;base64,AAAA'}]}),/IMAGE_PAYLOAD_DISABLED/);
const packet=approveRequest(request,1000);
const normal='Criterion A-3 scored 75% on 2026-08-05; tactic FIN-12 in 30 days 😀 𝄞';
assert.equal(inspectOutput(normal,packet,2000).text,normal);
assert.equal(inspectOutput('Email a@b.com, phone +1 212-555-0199, IP 10.0.0.1',packet,2000).text,'Email [REDACTED_EMAIL], phone [REDACTED_PHONE], IP [REDACTED_IP]');
for(let i=0;i<3;i++) assert.doesNotThrow(()=>inspectOutput(normal,packet));
assert.throws(()=>inspectOutput('bad\uD800',packet),/OUTPUT_INSPECTION_REJECTED/);
assert.throws(()=>inspectOutput('password=hunter2',packet),/OUTPUT_INSPECTION_REJECTED/);
assert.throws(()=>authorizeDestination('preflight','anthropic','claude-opus-4-7',{}),/DESTINATION_NOT_AUTHORIZED/);
assert.throws(()=>authorizeDestination('preflight','openai','gpt-5.5',{max_tokens:12000,reasoning_effort:'high'}),/INVALID_MODEL_SETTINGS/);

process.env.SECRET_KEY='test-secret-key-that-is-long-enough-123'; process.env.OPENAI_API_KEY='mock-key';
const cookie=issueCookie().split(';')[0];
class Req extends EventEmitter { constructor(body){super();this.method='POST';this.body=body;this.headers={cookie};} }
class Res { constructor(){this.headers={};this.frames='';this.headersSent=false;this.writableEnded=false;this.destroyed=false;} status(n){this.statusCode=n;return this;} setHeader(k,v){this.headers[k]=v;} flushHeaders(){this.headersSent=true;} json(v){this.headersSent=true;this.jsonBody=v;this.writableEnded=true;return this;} write(v){this.headersSent=true;this.frames+=v;return true;} end(v=''){this.frames+=v;this.writableEnded=true;return this;} }
const dispatch=p=>({packet_id:p.packet_id,packet_hash:p.packet_hash,schema_version:p.schema_version,policy_version:p.policy_version,run_id:p.run_id,stage:p.stage,internal_pipeline_call:true,internal_call_id:`call-${Math.random()}`});
let upstreamCalls=0,upstreamBody;
let upstreamPayload={status:'completed',output_text:'Governed result for user@example.com',usage:{output_tokens:2}};
globalThis.fetch=async(_url,opts)=>{upstreamCalls++;upstreamBody=JSON.parse(opts.body);assert.ok(opts.signal instanceof AbortSignal);return {ok:true,json:async()=>upstreamPayload};};
const timers=[]; const handler=providerHandler('openai',{setIntervalFn:(fn,ms)=>{timers.push([fn,ms]);return 1;},clearIntervalFn:()=>{},setTimeoutFn:(fn,ms)=>{timers.push([fn,ms]);return 2;},clearTimeoutFn:()=>{}});
for(const bad of [{prompt:'raw'}, {...dispatch(packet),internal_pipeline_call:false}, {...dispatch(packet),packet_id:'unknown'}]){const before=upstreamCalls;await handler(new Req(bad),new Res());assert.equal(upstreamCalls,before);}
for(const mutate of [
  (p,b)=>({...b,packet_hash:'0'.repeat(64)}),
  (p,b)=>({...b,stage:'fact_check'}),
]){resetPacketStoreForTests();const rejected=approveRequest(request);storeApprovedPacket(rejected);const before=upstreamCalls;await handler(new Req(mutate(rejected,dispatch(rejected))),new Res());assert.equal(upstreamCalls,before,'invalid packet binding must make zero upstream calls');}
resetPacketStoreForTests();const expired=approveRequest(request,1000);storeApprovedPacket(expired);setPacketStoreClockForTests(()=>200000);const beforeExpired=upstreamCalls;await handler(new Req(dispatch(expired)),new Res());assert.equal(upstreamCalls,beforeExpired,'expired packet must make zero upstream calls');
resetPacketStoreForTests();clearInternalModelResultsForTests();const valid=approveRequest(request);storeApprovedPacket(valid);const body=dispatch(valid);const res=new Res();await handler(new Req(body),res);
assert.equal(upstreamCalls,1);assert.equal(upstreamBody.instructions,valid.system_instruction);assert.deepEqual(upstreamBody.input[0].content,valid.parts.map(p=>({type:'input_text',text:p.text})));
assert.equal(timers.find(x=>x[1]===15000)?.[1],15000);assert.equal(timers.find(x=>x[1]===540000)?.[1],540000);assert.doesNotMatch(res.frames,/"type":"text"/);assert.match(res.frames,/REDACTED_EMAIL/);
assert.equal(getInternalModelResult(body.internal_call_id).output.text,'Governed result for [REDACTED_EMAIL]');
await handler(new Req(body),new Res());assert.equal(upstreamCalls,1,'packet is single use');
resetPacketStoreForTests();storeApprovedPacket(valid);assert.throws(()=>storeApprovedPacket(valid),/PACKET_ID_COLLISION/);

resetPacketStoreForTests();clearInternalModelResultsForTests();const collisionPacket=approveRequest(request);const collisionBody={...dispatch(collisionPacket),internal_call_id:'call-collision'};const collisionMetadata={runId:collisionPacket.run_id,stage:collisionPacket.stage,provider:collisionPacket.provider,model:collisionPacket.model,packetId:collisionPacket.packet_id,packetHash:collisionPacket.packet_hash};registerInternalModelResult(collisionBody.internal_call_id,collisionMetadata);storeApprovedPacket(collisionPacket);const collisionRes=new Res();const beforeCollision=upstreamCalls;await handler(new Req(collisionBody),collisionRes);assert.equal(upstreamCalls,beforeCollision);assert.equal(getInternalModelResult(collisionBody.internal_call_id).status,'pending','collision must not corrupt the original reservation');

resetPacketStoreForTests();clearInternalModelResultsForTests();const secretPacket=approveRequest(request);const secretBody=dispatch(secretPacket);storeApprovedPacket(secretPacket);upstreamPayload={status:'completed',output_text:'password=hunter2'};const secretRes=new Res();await handler(new Req(secretBody),secretRes);assert.match(secretRes.frames,/OUTPUT_INSPECTION_REJECTED/);assert.equal(getInternalModelResult(secretBody.internal_call_id).status,'error');assert.equal(getInternalModelResult(secretBody.internal_call_id).output,undefined);

resetPacketStoreForTests();clearInternalModelResultsForTests();const incompletePacket=approveRequest(request);const incompleteBody=dispatch(incompletePacket);storeApprovedPacket(incompletePacket);upstreamPayload={status:'incomplete',output_text:'partial',incomplete_details:{reason:'max_output_tokens'}};const incompleteRes=new Res();await handler(new Req(incompleteBody),incompleteRes);assert.match(incompleteRes.frames,/INCOMPLETE_RESPONSE/);assert.equal(getInternalModelResult(incompleteBody.internal_call_id).status,'error');

resetPacketStoreForTests();clearInternalModelResultsForTests();const closedPacket=approveRequest(request);const closedBody=dispatch(closedPacket);storeApprovedPacket(closedPacket);upstreamPayload={status:'completed',output_text:'completed after response close'};const closedRes=new Res();closedRes.destroyed=true;await handler(new Req(closedBody),closedRes);assert.equal(getInternalModelResult(closedBody.internal_call_id).status,'done','inspected output must remain recoverable after response-side close');assert.equal(closedRes.frames,'','closed response must not receive output content');

const capturedLogs=[];const originalLog=console.log;console.log=(...args)=>capturedLogs.push(args.join(' '));try{resetPacketStoreForTests();clearInternalModelResultsForTests();const loggedPacket=approveRequest(request);storeApprovedPacket(loggedPacket);upstreamPayload={status:'completed',output_text:'private output marker'};await handler(new Req(dispatch(loggedPacket)),new Res());}finally{console.log=originalLog;}assert.doesNotMatch(capturedLogs.join('\n'),/monthly invoice review|private output marker|user@example\.com|base64/i,'gateway logs must remain content-free');
console.log('governance and gateway behavioral tests passed');
