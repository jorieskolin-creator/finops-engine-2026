import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=await mkdtemp(join(tmpdir(),'finops-result-recovery-'));const outfile=join(dir,'router.mjs');
await build({entryPoints:[new URL('../src/services/modelRouter.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});
const {pollInternalResult,StageExecutionError}=await import(`file://${outfile}`);
const body={internal_pipeline_call:true,internal_call_id:'00000000-0000-4000-8000-000000000001',run_id:'run',stage:'preflight',packet_id:'packet',packet_hash:'hash'};
const approval={provider:'openai',model:'model',packet_id:'packet',packet_hash:'hash'};
const outputText='safe';const output={schema_version:'governed_output_v1',policy_version:'llm_egress_policy_v1',inspection_status:'passed',inspection_method:'deterministic_pattern_screen_and_contact_redaction_v1',run_id:'run',stage:'preflight',provider:'openai',model:'model',source_packet_id:'packet',source_packet_hash:'hash',text:outputText,char_count:outputText.length,output_hash:crypto.createHash('sha256').update(outputText).digest('hex')};
const response=status=>({status:200,ok:true,json:async()=>status==='done'?{status,output,usage:{output_tokens:1}}:{status}});
const options=statuses=>{let now=1_000,index=0,calls=0;return{value:{fetchFn:async()=>{calls++;return response(statuses[Math.min(index++,statuses.length-1)]);},sleepFn:async ms=>{now+=ms;},now:()=>now,logFn:async()=>{},gatewayDeadlineMs:0,recoveryPropagationMs:20,pollIntervalMs:5,missingGraceMs:5},calls:()=>calls};};

{const o=options(['running','running','running','done']);const recovered=await pollInternalResult(body,approval,new DOMException('timeout','AbortError'),1_000,o.value);assert.equal(recovered.text,'safe');assert.equal(o.calls(),4,'running work must remain recoverable beyond the former short propagation window');}
for(const [status,fallbackAllowed] of [['outcome_unknown',false],['fallback_allowed',true]]){const o=options([status]);await assert.rejects(()=>pollInternalResult(body,approval,new Error('stream'),1_000,o.value),error=>error instanceof StageExecutionError&&error.code===status.toUpperCase()&&error.fallbackAllowed===fallbackAllowed);assert.equal(o.calls(),1);}
{const o=options(['running']);const result=await pollInternalResult(body,approval,new DOMException('timeout','AbortError'),1_000,o.value);assert.equal(result,null);assert.ok(o.calls()>=4);}

console.log('internal result recovery tests passed');
