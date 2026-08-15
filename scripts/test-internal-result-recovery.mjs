import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=await mkdtemp(join(tmpdir(),'finops-result-recovery-'));const outfile=join(dir,'router.mjs');
await build({entryPoints:[new URL('../src/services/modelRouter.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});
const {callModel,pollInternalResult,StageExecutionError}=await import(`file://${outfile}`);
const body={internal_pipeline_call:true,internal_call_id:'00000000-0000-4000-8000-000000000001',run_id:'run',stage:'forensic_audit',packet_id:'packet',packet_hash:'hash'};
const approval={provider:'openai',model:'model',packet_id:'packet',packet_hash:'hash'};
const outputText='safe';const output={schema_version:'governed_output_v1',policy_version:'llm_egress_policy_v1',inspection_status:'passed',inspection_method:'deterministic_pattern_screen_and_contact_redaction_v1',run_id:'run',stage:'forensic_audit',provider:'openai',model:'model',source_packet_id:'packet',source_packet_hash:'hash',text:outputText,char_count:outputText.length,output_hash:crypto.createHash('sha256').update(outputText).digest('hex')};
const response=status=>({status:200,ok:true,json:async()=>status==='done'?{status,output,usage:{output_tokens:1}}:{status}});
const options=statuses=>{let now=1_000,index=0,calls=0;return{value:{fetchFn:async()=>{calls++;return response(statuses[Math.min(index++,statuses.length-1)]);},sleepFn:async ms=>{now+=ms;},now:()=>now,logFn:async()=>{},gatewayDeadlineMs:0,recoveryPropagationMs:20,pollIntervalMs:5,missingGraceMs:5},calls:()=>calls};};

{const o=options(['running','running','running','done']);const recovered=await pollInternalResult(body,approval,new DOMException('timeout','AbortError'),1_000,o.value);assert.equal(recovered.text,'safe');assert.equal(o.calls(),4,'running work must remain recoverable beyond the former short propagation window');}
for(const [status,fallbackAllowed] of [['outcome_unknown',false],['fallback_allowed',true]]){const o=options([status]);await assert.rejects(()=>pollInternalResult(body,approval,new Error('stream'),1_000,o.value),error=>error instanceof StageExecutionError&&error.code===status.toUpperCase()&&error.fallbackAllowed===fallbackAllowed);assert.equal(o.calls(),1);}
{const o=options(['running']);const result=await pollInternalResult(body,approval,new DOMException('timeout','AbortError'),1_000,o.value);assert.equal(result,null);assert.ok(o.calls()>=4);}
{
  let now=1_000;
  const recovery={
    fetchFn:async()=>({status:404,ok:false,json:async()=>({status:'missing'})}),
    sleepFn:async ms=>{now+=ms;},now:()=>now,logFn:async()=>{},gatewayDeadlineMs:0,recoveryPropagationMs:20,pollIntervalMs:5,missingGraceMs:5,
  };
  await assert.rejects(
    ()=>pollInternalResult(body,approval,new Error('gateway 500'),1_000,recovery),
    error=>error instanceof StageExecutionError&&error.code==='NO_ATTEMPT_RESERVED'&&error.fallbackAllowed,
    'a stably absent attempt is known to be pre-send and must allow the configured fallback',
  );
}

{
  const originalFetch=globalThis.fetch;
  const calls=[];
  const packet={
    schema_version:'approved_stage_packet_v1',policy_version:'llm_egress_policy_v1',
    packet_id:'packet',packet_hash:'hash',run_id:'run',stage:'synthesis',provider:'openai',model:'model',
    output_contract:'finops_evidence_synthesis_v1',
    classification_method:'deterministic_pattern_screen_v1',approval_basis:'policy_approved_after_pattern_screening'
  };
  globalThis.fetch=async(url)=>{
    calls.push(String(url));
    if(url==='/api/governed-packet')return new Response(JSON.stringify(packet),{status:201,headers:{'Content-Type':'application/json'}});
    if(url==='/api/openai-generate')return new Response(JSON.stringify({error:'PACKET_UNAVAILABLE'}),{status:404,headers:{'Content-Type':'application/json'}});
    if(url==='/api/log')return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
    throw new Error(`Unexpected URL ${url}`);
  };
  try{
    await assert.rejects(
      ()=>callModel({id:'model',provider:'openai',maxTokens:100},{userText:'safe',outputContract:'finops_evidence_synthesis_v1'},'synthesis',{runId:'run'}),
      error=>error instanceof StageExecutionError&&error.code==='FALLBACK_ALLOWED'&&error.fallbackAllowed
    );
    assert.equal(calls.filter(url=>url==='/api/model-result').length,0,'a pre-reservation 404 must not enter ambiguous-result recovery');
    assert.equal(calls.filter(url=>url==='/api/log').length,1,'the safe gateway rejection should be observable');
  }finally{globalThis.fetch=originalFetch;}
}

console.log('internal result recovery tests passed');
