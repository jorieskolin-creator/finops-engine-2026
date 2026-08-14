import assert from 'node:assert/strict';
import { modelResultHandler } from '../api/model-result.js';
import { issueCookie } from '../lib/auth.js';
import { inspectOutput } from '../lib/governance.js';
process.env.SECRET_KEY='test-secret-key-that-is-long-enough-123';
const attempt={attempt_id:'a',internal_call_id:'123e4567-e89b-12d3-a456-426614174000',run_id:'r',packet_id:'p',packet_hash:'h',provider:'openai',model:'m',stage:'forensic_audit',state:'outcome_unknown'};
const req={method:'POST',headers:{cookie:''},body:{internalCallId:attempt.internal_call_id}};const res={status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
// Auth is deliberately tested elsewhere; inject a malformed cookie and verify closed authentication.
await modelResultHandler({getAttemptByInternalCallId:async()=>attempt},{getResult:async()=>null})(req,res);assert.equal(res.statusCode,401);
const source=await (await import('node:fs/promises')).readFile(new URL('../api/model-result.js',import.meta.url),'utf8');assert.match(source,/result_unavailable/);assert.doesNotMatch(source,/internalModelResults/);
const cookie=issueCookie().split(';')[0];
const response=()=>({status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
const call=async(repository,redis={getResult:async()=>null})=>{const out=response();await modelResultHandler(repository,redis)({...req,headers:{cookie}},out);return out;};
assert.equal((await call({getAttemptByInternalCallId:async()=>null})).statusCode,404);
for(const state of ['queued','send_authorized']){const out=await call({getAttemptByInternalCallId:async()=>({...attempt,state})});assert.equal(out.body.status,state==='queued'?'queued':'running');}
const missing=await call({getAttemptByInternalCallId:async()=>({...attempt,state:'succeeded'})});assert.equal(missing.body.status,'result_unavailable');
const invalid=await call({getAttemptByInternalCallId:async()=>({...attempt,state:'succeeded'})},{getResult:async()=>'{"output":{}}'});assert.equal(invalid.statusCode,503);assert.equal(invalid.body.status,'result_unavailable');
const governed=inspectOutput('governed result',{packet_id:attempt.packet_id,packet_hash:attempt.packet_hash,run_id:attempt.run_id,provider:attempt.provider,model:attempt.model,stage:attempt.stage});
const done=await call({getAttemptByInternalCallId:async()=>({...attempt,state:'succeeded'})},{getResult:async()=>JSON.stringify({status:'done',output:governed,usage:{output_tokens:2}})});assert.equal(done.statusCode,200);assert.equal(done.body.status,'done');assert.equal(done.body.output.text,'governed result');
console.log('shared result integrity tests passed');
