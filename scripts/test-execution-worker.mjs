import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ExecutionWorker,AttemptReconciler,OutboxPublisher } from '../lib/executionWorker.js';
import { approveRequest,inspectOutput,POLICY_VERSION,STAGE_PACKET_REQUEST_VERSION } from '../lib/governance.js';
import { providerHandler } from '../lib/providerGateway.js';
import { issueCookie } from '../lib/auth.js';
import { OUTPUT_CONTRACT_IDS } from '../lib/outputContracts.js';

const packet=approveRequest({schema_version:STAGE_PACKET_REQUEST_VERSION,policy_version:POLICY_VERSION,run_id:'run-1',stage:'forensic_audit',provider:'openai',model:'gpt-5.6-sol',destination:'openai:external_model',system_instruction:'safe',parts:[{type:'text',text:'public information'}],settings:{max_tokens:32768,reasoning_effort:'high'}});
class Repo{
  constructor(state='queued',packetValue=packet){this.packet=packetValue;this.a={attempt_id:'a',run_id:'run-1',packet_id:packetValue.packet_id,packet_hash:packetValue.packet_hash,provider:'openai',model:'gpt-5.6-sol',stage:packetValue.stage,state,run_state:'active',created_at:new Date(),effective_expires_at:new Date(Date.now()+60e3),absolute_deadline_at:new Date(Date.now()+60e3),lease_token:0};}
  async claimAttempt(_id,owner){if(!['queued','dispatch_intent'].includes(this.a.state)||this.a.leased)return null;this.a.leased=true;this.a.lease_owner=owner;this.a.lease_token++;return {...this.a};}async getAttempt(){return {...this.a};}
  async transitionAttempt(_id,from,to,c={}){if(this.a.state!==from)return null;this.a.state=to;this.a.outcome_code=c.outcomeCode;return {...this.a};}async authorizeAttempt(_id,owner,t){if(this.a.state!=='dispatch_intent'||this.a.lease_owner!==owner||this.a.lease_token!==t)return null;this.a.state='send_authorized';return {...this.a};}async renewAttemptLease(){this.renewals=(this.renewals||0)+1;return this.renew!==false;}async reconcileStale(){}async listReconciliationCandidates(){return [this.a];}async recoverSucceeded(){this.a.state='succeeded';return this.a;}
}
class Redis{
  constructor(packetValue=packet){this.packet=packetValue;this.marker=null;this.result=null;this.client={exists:async()=>1};}key(){return'pending';}async getActivePacket(){return JSON.stringify(this.packet);}async setLease(){return 1;}async renewLease(){this.renewals=(this.renewals||0)+1;return this.renew!==false;}async authorizeSend({token}){if(this.marker)return this.marker===String(token)?2:3;this.marker=String(token);return 1;}async setResult({value}){if(this.failResult)return 0;this.result=value;return 1;}async getResult(){return this.result;}async getSendMarker(){return this.marker;}async notifyAttempt(){this.notified=true;}
}
const worker=(repo,redis,invoke,extra={})=>new ExecutionWorker({repository:repo,redis,invoke,providerConfigured:()=>true,heartbeatMs:5,leaseSeconds:1,...extra});

// Duplicate delivery in one process and two owners are fenced by one CAS lease.
for(const owners of [['one','one'],['one','two']]){const repo=new Repo(),redis=new Redis();let calls=0;const invoke=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return{text:'ok',usage:{}};};await Promise.all(owners.map(owner=>worker(repo,redis,invoke,{owner}).process('a')));assert.equal(calls,1);assert.equal(repo.a.state,'succeeded');}
// A heartbeat keeps both fences alive during a long invocation.
{const repo=new Repo(),redis=new Redis();await worker(repo,redis,async()=>{await new Promise(r=>setTimeout(r,18));return{text:'ok',usage:{}};}).process('a');assert.ok(repo.renewals>=2);assert.ok(redis.renewals>=2);assert.equal(repo.a.state,'succeeded');}
// The stream must resume from retained entries. `$` can skip notifications
// published between blocking reads and leave authoritative attempts queued.
{const cursors=[];let instance;const redis={readAttempts:async cursor=>{cursors.push(cursor);instance.stopped=true;return[];}};instance=worker({},redis,async()=>({text:'ok',usage:{}}));instance.stopped=false;await instance.loop();assert.deepEqual(cursors,['0-0']);}
// Publishing marks the durable outbox only after the Redis notification exists.
{const calls=[];const publisher=new OutboxPublisher({repository:{claimPendingOutbox:async()=>[{outbox_id:'o',attempt_id:'a',run_id:'r'}],markPublished:async()=>{calls.push('marked');return true;}},redis:{notifyAttempt:async()=>calls.push('notified')}});await publisher.tick();assert.deepEqual(calls,['notified','marked']);}
// A queued attempt may wait through a full wave of slow domain calls without
// incorrectly exhausting its model route.
{const repo=new Repo(),redis=new Redis();repo.a.created_at=new Date(Date.now()-61_000);let calls=0;await worker(repo,redis,async()=>{calls++;return{text:'ok',usage:{}};}).process('a');assert.equal(calls,1);assert.equal(repo.a.state,'succeeded');}
// A genuinely stale queued attempt has not crossed the send boundary and may safely fall back.
{const repo=new Repo(),redis=new Redis();repo.a.created_at=new Date(Date.now()-481_000);let calls=0;await worker(repo,redis,async()=>{calls++;}).process('a');assert.equal(calls,0);assert.equal(repo.a.state,'fallback_allowed');assert.equal(repo.a.outcome_code,'QUEUE_WAIT_EXCEEDED');assert.equal(redis.marker,null);}
// Marker created by a crashed worker is ambiguous and never redispatched.
{const repo=new Repo('dispatch_intent'),redis=new Redis();redis.marker='older';let calls=0;await worker(repo,redis,async()=>{calls++;}).process('a');assert.equal(calls,0);assert.equal(repo.a.state,'outcome_unknown');}
// A pre-marker dispatch_intent redelivery is safe and sends exactly once.
{const repo=new Repo('dispatch_intent'),redis=new Redis();let calls=0;await worker(repo,redis,async()=>{calls++;return{text:'ok',usage:{}};}).process('a');assert.equal(calls,1);assert.equal(repo.a.state,'succeeded');}
// Lease reclaim before the marker cannot let either owner send after stale-queue fallback wins.
{const repo=new Repo();repo.a.created_at=new Date(Date.now()-481_000);repo.claimAttempt=async(_id,owner)=>{repo.a.lease_owner=owner;repo.a.lease_token++;return{...repo.a};};let releaseFirst;const firstPacket=new Promise(resolve=>{releaseFirst=resolve;});let packetReads=0;const redis=new Redis();redis.getActivePacket=async()=>{packetReads++;if(packetReads===1)await firstPacket;return JSON.stringify(packet);};let calls=0;const a=worker(repo,redis,async()=>{calls++;},{owner:'one'}).process('a');while(packetReads<1)await new Promise(resolve=>setTimeout(resolve,1));const b=worker(repo,redis,async()=>{calls++;},{owner:'two'}).process('a');await b;releaseFirst();await a;assert.equal(repo.a.state,'fallback_allowed');assert.equal(calls,0);assert.equal(redis.marker,null);}
// A pre-marker crash safely republishes; a marker crash is classified unknown.
{const repo=new Repo('dispatch_intent'),redis=new Redis();repo.a.leased=false;const r=new AttemptReconciler({repository:repo,redis});await r.tick();assert.equal(redis.notified,true);redis.marker='1';redis.notified=false;await r.tick();assert.equal(repo.a.state,'outcome_unknown');assert.equal(redis.notified,false);}
// Durable governed output wins reconciliation after a DB-write crash.
{const repo=new Repo('send_authorized'),redis=new Redis();redis.result=JSON.stringify({status:'done',output:inspectOutput('safe result',packet),usage:{input_tokens:2}});await new AttemptReconciler({repository:repo,redis}).tick();assert.equal(repo.a.state,'succeeded');}
// Result persistence failure cannot become fallback.
{const repo=new Repo(),redis=new Redis();redis.failResult=true;await worker(repo,redis,async()=>({text:'ok',usage:{}})).process('a');assert.equal(repo.a.state,'result_unavailable');assert.notEqual(repo.a.state,'fallback_allowed');}
// Transport/timeout are unknown; explicit HTTP/incomplete/inspection failures allow fallback.
for(const [code,expected] of [['TRANSPORT','outcome_unknown'],['AbortError','outcome_unknown'],['UPSTREAM_HTTP_ERROR','fallback_allowed'],['INCOMPLETE_RESPONSE','fallback_allowed'],['OUTPUT_INSPECTION_REJECTED','fallback_allowed']]){const repo=new Repo(),redis=new Redis();await worker(repo,redis,async()=>{const e=new Error();if(code==='AbortError')e.name=code;else e.code=code;throw e;}).process('a');assert.equal(repo.a.state,expected);}
// Transport-successful malformed, truncated, multi-object, and schema-invalid
// synthesis responses are rejected before persistence and allow fallback.
{const contractPacket=approveRequest({schema_version:STAGE_PACKET_REQUEST_VERSION,policy_version:POLICY_VERSION,run_id:'run-1',stage:'synthesis',provider:'openai',model:'gpt-5.6-sol',destination:'openai:external_model',system_instruction:'Return JSON',parts:[{type:'text',text:'public information'}],settings:{max_tokens:32768,reasoning_effort:'high'},output_contract:OUTPUT_CONTRACT_IDS.evidenceSynthesis});for(const text of ['not json','{"phase_3_strategy":', '{"phase_3_strategy":{}}\n{"extra":true}','{"phase_3_strategy":{}}']){const repo=new Repo('queued',contractPacket),redis=new Redis(contractPacket);await worker(repo,redis,async()=>({text,usage:{}})).process('a');assert.equal(repo.a.state,'fallback_allowed');assert.equal(repo.a.outcome_code,'INVALID_OUTPUT_CONTRACT');assert.equal(redis.result,null);}}
// Fence loss aborts locally and remains unknown.
{const repo=new Repo(),redis=new Redis();repo.renew=false;await worker(repo,redis,(_p,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'}))))).process('a');assert.equal(repo.a.state,'outcome_unknown');}

// Closing the browser response stops gateway polling but never cancels the queued worker attempt.
process.env.SECRET_KEY='test-secret-key-that-is-long-enough-123';
class Request extends EventEmitter{constructor(body){super();this.method='POST';this.body=body;this.headers={cookie:issueCookie().split(';')[0]};}}
class Response extends EventEmitter{constructor(){super();this.frames='';this.headersSent=false;this.writableEnded=false;this.destroyed=false;}status(n){this.statusCode=n;return this;}setHeader(){}flushHeaders(){this.headersSent=true;}write(value){this.frames+=value;return true;}end(){this.writableEnded=true;return this;}json(value){this.body=value;this.writableEnded=true;return this;}}
{let reserved=false,cleared=false;const attempt={attempt_id:'123e4567-e89b-12d3-a456-426614174001',internal_call_id:'123e4567-e89b-12d3-a456-426614174002',run_id:packet.run_id,packet_id:packet.packet_id,packet_hash:packet.packet_hash,provider:packet.provider,model:packet.model,stage:packet.stage,state:'queued'};const repository={claimPacketAndReserve:async()=>{reserved=true;return attempt;},getAttemptByInternalCallId:async()=>attempt};const redis={getActivePacket:async()=>JSON.stringify(packet)};const body={packet_id:packet.packet_id,packet_hash:packet.packet_hash,schema_version:packet.schema_version,policy_version:packet.policy_version,run_id:packet.run_id,stage:packet.stage,internal_pipeline_call:true,internal_call_id:attempt.internal_call_id};const response=new Response();await providerHandler('openai',{repository,redis,setIntervalFn:()=>1,clearIntervalFn:()=>{cleared=true;}})(new Request(body),response);assert.equal(reserved,true);assert.match(response.frames,/keepalive/);response.emit('close');assert.equal(cleared,true);assert.equal(attempt.state,'queued');}
console.log('execution worker behavioral tests passed');
