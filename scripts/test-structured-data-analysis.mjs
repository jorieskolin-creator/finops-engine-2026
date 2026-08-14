import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const source=await readFile(new URL('../src/services/structuredDataAnalysisService.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2020,importsNotUsedAsValues:ts.ImportsNotUsedAsValues.Remove}}).outputText;
const dir=await mkdtemp(join(tmpdir(),'finops-structured-data-'));const path=join(dir,'structuredDataAnalysisService.mjs');await writeFile(path,compiled);
const {analyzeTaggingAllocationTable,DATA_SIGNAL_REGISTRY}=await import(`file://${path}`);
const sourceRecord={schema_version:'source_record_v1',source_id:'table-1',source_name:'allocation.csv',kind:'csv',text:'model-visible bounded table',structured_table:{schema_version:'structured_table_v1',headers:['Owner','Cost Center','Tags','Spend'],rows:[['Alice','CC-1','prod','100'],['','unallocated','','50']],total_row_count:2,truncated:false}};
const evidence=analyzeTaggingAllocationTable(sourceRecord);
assert.equal(DATA_SIGNAL_REGISTRY.length,3);assert.equal(evidence.mode,'shadow');assert.equal(evidence.result.status,'OBSERVED');assert.equal(evidence.result.mapping_population_coverage,50);assert.equal(evidence.result.tagging_population_coverage,50);assert.equal(evidence.result.allocation_population_coverage,50);assert.equal(evidence.raw_value_exposure,false);
assert.equal(evidence.result.row_scope,'full_table');assert.equal(evidence.result.source_row_count,2);assert.equal(evidence.result.row_truncated,false);
assert.deepEqual(evidence.targets,[{stream:'maturity',criterion_id:'A1'},{stream:'antipattern',criterion_id:'A1'}]);
assert.doesNotMatch(JSON.stringify(evidence),/Alice|CC-1|prod|unallocated|100/,'derived evidence must not expose source cells');
const unrelated=analyzeTaggingAllocationTable({...sourceRecord,structured_table:{...sourceRecord.structured_table,headers:['Timestamp','Spend'],rows:[['2026-01','100']]}});assert.equal(unrelated.result.status,'INSUFFICIENT_SIGNAL');assert.equal(unrelated.result.mapping_population_coverage,null);
for(const header of ['unallocated_cost','overallocation_cost','etag_value']){const negative=analyzeTaggingAllocationTable({...sourceRecord,structured_table:{...sourceRecord.structured_table,headers:[header],rows:[['value']]}});assert.equal(negative.result.status,'INSUFFICIENT_SIGNAL',`${header} must not create a false signal`);}
for(const header of ['resource_tag_key','owner_email','billing_account']){const positive=analyzeTaggingAllocationTable({...sourceRecord,structured_table:{...sourceRecord.structured_table,headers:[header],rows:[['value']]}});assert.equal(positive.result.status,'OBSERVED',`${header} should match its canonical signal`);}
const bounded=analyzeTaggingAllocationTable({...sourceRecord,structured_table:{...sourceRecord.structured_table,total_row_count:1000,truncated:true}});assert.equal(bounded.result.row_scope,'bounded_prefix');assert.equal(bounded.result.source_row_count,1000);assert.equal(bounded.result.row_truncated,true);
const fullPopulation=analyzeTaggingAllocationTable({...sourceRecord,structured_table:{...sourceRecord.structured_table,rows:[['Alice','CC-1','prod','100']],analysis_rows:[['Alice','CC-1','prod','100'],['Bob','CC-2','prod','80'],['','','','50'],['','','','40']],total_row_count:4,analysis_complete:true,truncated:true}});assert.equal(fullPopulation.result.row_scope,'full_table');assert.equal(fullPopulation.result.analyzed_row_count,4);assert.equal(fullPopulation.result.mapping_population_coverage,50);assert.equal(fullPopulation.result.row_truncated,false);
assert.equal(Object.isFrozen(DATA_SIGNAL_REGISTRY),true);assert.equal(Object.isFrozen(DATA_SIGNAL_REGISTRY[0].canonical_fields),true);assert.equal(DATA_SIGNAL_REGISTRY.every(entry=>Object.isFrozen(entry)&&Object.isFrozen(entry.targets)&&entry.targets.every(Object.isFrozen)),true);
console.log('structured data analysis tests passed');
