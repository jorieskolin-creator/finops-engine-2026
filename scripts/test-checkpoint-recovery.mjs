import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const dir=await mkdtemp(join(tmpdir(),'finops-checkpoint-recovery-'));
for(const name of ['checkpointService','checkpointRecoveryService']){
  const source=await readFile(new URL(`../src/services/${name}.ts`,import.meta.url),'utf8');
  let output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2020,importsNotUsedAsValues:ts.ImportsNotUsedAsValues.Remove}}).outputText;
  output=output.replace("'./checkpointService'","'./checkpointService.mjs'");
  await writeFile(join(dir,`${name}.mjs`),output);
}
const {recoverCheckpointResult}=await import(`file://${join(dir,'checkpointRecoveryService.mjs')}`);
const originalFetch=globalThis.fetch;
const runId='00000000-0000-4000-8000-000000000001';
const metadata=(id,kind,scope,revision=1)=>({checkpoint_id:id,run_id:runId,kind,scope,revision,schema_version:'checkpoint_v1',payload_hash:id.replaceAll('-','').padEnd(64,'0').slice(0,64),char_count:100,parent_hash:null,state:'available',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString()});
const response=body=>({ok:true,json:async()=>body});

const finalMeta=metadata('00000000-0000-4000-8000-000000000011','final_report','ready_for_delivery');
const finalResult={meta:{run_id:runId},phase_2_validation:{metrics:{evidence_density:80}},phase_3_strategy:{remediation_roadmap:[]}};
globalThis.fetch=async url=>String(url).includes('checkpoint_id=')?response({metadata:finalMeta,payload:{result:finalResult}}):response({checkpoints:[finalMeta]});
assert.deepEqual(await recoverCheckpointResult(runId),{result:finalResult,complete:true},'a delivered report must be recovered exactly');

const phase1Meta=metadata('00000000-0000-4000-8000-000000000021','phase1','accepted');
const phase2Meta=metadata('00000000-0000-4000-8000-000000000022','phase2','accepted');
globalThis.fetch=async url=>{
  const value=String(url);
  if(!value.includes('checkpoint_id='))return response({checkpoints:[phase1Meta,phase2Meta]});
  if(value.includes(phase1Meta.checkpoint_id))return response({metadata:phase1Meta,payload:{phase_1_audit_logs:{maturity:{},antipattern:{}},evidence_check:{failed:false},validation:{valid:true}}});
  return response({metadata:phase2Meta,payload:{phase_2_validation:{metrics:{evidence_density:20,finops_readiness:15,antipattern_burden:10},crawl_walk_run:'Insufficient Evidence',silent_areas:['A1'],maturity_gaps:['Missing ownership'],antipattern_findings:[]}}});
};
const partial=await recoverCheckpointResult(runId);assert.equal(partial.complete,false);assert.equal(partial.result.quality_gate.decision,'BLOCK');assert.equal(partial.result.phase_3_strategy.planning_decision.decision,'NO_GO');assert.deepEqual(partial.result.phase_3_strategy.remediation_roadmap,[]);

const analysis=await readFile(new URL('../src/services/analysisService.ts',import.meta.url),'utf8');
for(const boundary of ['acquisition','phase1','phase2','synthesis','fact_check','quality_gate','final_report'])assert.ok(analysis.includes(`checkpoint('${boundary}'`),`missing ${boundary} recovery boundary`);
assert.match(analysis,/hasRecoverableCheckpoint[\s\S]*suspendRun/,'interruption after an accepted boundary must preserve Redis checkpoints');
assert.match(analysis,/const candidateStrategy[\s\S]*if \(candidateFactCheck\.failed\)[\s\S]*strategyData = candidateStrategy/,'late regeneration must promote only a verified candidate');
globalThis.fetch=originalFetch;
console.log('checkpoint recovery tests passed');
