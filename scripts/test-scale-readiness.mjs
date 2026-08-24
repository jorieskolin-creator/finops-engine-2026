import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';
import { emitTypescript } from './ts-emit.mjs';

const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2020,importsNotUsedAsValues:ts.ImportsNotUsedAsValues.Remove}}).outputText;
const dir=await mkdtemp(join(tmpdir(),'finops-scale-readiness-'));
const structuredOut=await emitTypescript(new URL('../src/services/structuredDataAnalysisService.ts',import.meta.url).pathname, join(dir,'structured'));
const {buildDataSignalCoverageReport,DATA_SIGNAL_REGISTRY,DATA_SIGNAL_REGISTRY_VERSION}=await import(`file://${structuredOut}`);
const coverage=buildDataSignalCoverageReport();
assert.equal(DATA_SIGNAL_REGISTRY.length,3,'tagging field registry stays three entries');
assert.equal(coverage.mode,'active');
assert.equal(coverage.registry_version,DATA_SIGNAL_REGISTRY_VERSION);
assert.equal(coverage.total_object_count,60);
assert.equal(coverage.objects.length,60);
assert.ok(coverage.analyzer_available_count>2,'must stop reporting 2/60 once catalog bindings are live');
assert.equal(coverage.analyzer_available_count,25);
assert.equal(coverage.unsupported_count,35);
assert.equal(coverage.analyzer_available_count+coverage.unsupported_count,60);
const authoritative=coverage.objects.filter(object=>object.status==='AUTHORITATIVE_ANALYZER_AVAILABLE').map(object=>`${object.stream}:${object.criterion_id}`).sort();
assert.ok(authoritative.includes('maturity:A1'));
assert.ok(authoritative.includes('maturity:C2'));
assert.ok(authoritative.includes('maturity:A5'));
assert.ok(authoritative.includes('maturity:F3'));
assert.ok(authoritative.includes('antipattern:AP-A1'));
assert.equal(authoritative.includes('maturity:E3'),false);
assert.equal(authoritative.includes('maturity:D4'),false);
assert.equal(authoritative.includes('maturity:D5'),false);
assert.equal(authoritative.includes('maturity:E4'),false);
assert.equal(authoritative.includes('maturity:E5'),false);
assert.equal(authoritative.includes('maturity:F5'),false);
assert.equal(authoritative.includes('antipattern:AP-C2'),false);
assert.equal(new Set(coverage.objects.map(object=>`${object.stream}:${object.criterion_id}`)).size,60);
assert.ok(coverage.objects.filter(object=>object.status==='NO_AUTHORITATIVE_ANALYZER_SEMANTICS').every(object=>object.analyzer_ids.length===0));
const a1=coverage.objects.find(object=>object.stream==='maturity'&&object.criterion_id==='A1');
assert.ok(a1.analyzer_ids.includes('tagging_allocation_v1'));
assert.ok(a1.analyzer_ids.includes('trend_v1'));
assert.equal(a1.analyzer_ids.includes('crucial_item_coverage_v1'),false,'coverage is not a data-signal analyzer');
const c2=coverage.objects.find(object=>object.stream==='maturity'&&object.criterion_id==='C2');
assert.ok(c2.analyzer_ids.includes('trend_v1'));
assert.equal(c2.analyzer_ids.includes('tagging_allocation_v1'),false);
const e3=coverage.objects.find(object=>object.stream==='maturity'&&object.criterion_id==='E3');
assert.equal(e3.status,'NO_AUTHORITATIVE_ANALYZER_SEMANTICS');
assert.deepEqual(e3.analyzer_ids,[]);

const kbSource=await readFile(new URL('../src/knowledge_base/index.ts',import.meta.url),'utf8');const packetSource=`const BATCH_IDS=['A','B','C','D','E','F'];\n${kbSource.slice(kbSource.indexOf('const SHADOW_SECTION_LIMIT'),kbSource.indexOf('\nconst formatKbDoc'))}`;await writeFile(join(dir,'packetBuilder.mjs'),compile(packetSource));const {buildShadowKnowledgePacket}=await import(`file://${join(dir,'packetBuilder.mjs')}`);
const sectionKeys=['canonical_definition','primary_assessment_questions','state_interpretation','detailed_interpretation','evidence_requirements','strong_evidence_examples','moderate_evidence_examples','weak_evidence_examples','contradictory_evidence_examples','accepted_evidence_types','provider_mapping','focus_normalized_interpretation','false_positive_guards','validation_questions','detection_heuristics','operational_indicators','prohibited_inference_rules','scoring_guidance','related_capabilities','risk_notes','remediation_tactic_notes'];
const sectionsFor=id=>Object.fromEntries(sectionKeys.map(key=>[key,`${id} ${key} governed content.`]));
const documents=['A','B','C','D','E','F'].flatMap(domain=>Array.from({length:5},(_,offset)=>{
  const id=`${domain}${offset+1}`;
  return ['maturity','antipattern'].map(stream=>({
    pathname:`${stream}-${id}.pdf`,pdf_sha256:`pdf-${stream}-${id}`,extracted_text_sha256:`text-${stream}-${id}`,
    kb_id:`kb-${stream}-${id}`,version:'1.0.0',domain_id:domain,domain_name:domain,stream,
    criterion_id:stream==='antipattern'?`AP-${id}`:id,capability_id:id,title:id,evidence_categories:[],
    allowed_uses:['rubric_context'],forbidden_uses:['customer_evidence'],legacy_ids:[],
    extraction:{sparse_pages:[],page_limit_reached:false,section_count:sectionKeys.length,duplicate_section_headings:[],section_order_valid:true},
    sections:sectionsFor(id),body_excerpt:'complete'
  }));
}).flat());
const index={documents,status:{source:'remote_blob',document_count:60,failure_count:0}};const stages=['forensic_audit','evidence_check','synthesis','roadmap_synthesis'];const packetKeys=[];
const requiredByStage={forensic_audit:['canonical_definition','evidence_requirements','false_positive_guards','validation_questions','scoring_guidance'],evidence_check:['canonical_definition','evidence_requirements','false_positive_guards','validation_questions'],synthesis:['canonical_definition','evidence_requirements','false_positive_guards'],roadmap_synthesis:['canonical_definition','risk_notes','remediation_tactic_notes']};
for(const domain of ['A','B','C','D','E','F'])for(const stage of stages){const packet=buildShadowKnowledgePacket(index,{batchId:domain,stage});packetKeys.push(`${domain}:${stage}`);assert.equal(packet.readiness,'READY',`${domain}:${stage} must be READY`);assert.equal(packet.document_count,10);assert.equal(packet.coverage_issues.length,0);assert.equal(packet.missing_requirements.length,0);assert.equal(packet.oversized_sections.length,0);assert.equal(packet.page_limit_documents.length,0);assert.ok(packet.documents.every(document=>document.pdf_sha256&&document.extracted_text_sha256&&document.omitted_sections.length===0));assert.equal(new Set(packet.documents.map(document=>`${document.stream}:${document.criterion_id}`)).size,10);for(const document of packet.documents){for(const required of requiredByStage[stage])assert.ok(document.included_sections.includes(required),`${domain}:${stage}:${document.criterion_id} must include ${required}`);if(document.stream==='antipattern'&&stage!=='roadmap_synthesis')for(const required of ['state_interpretation','prohibited_inference_rules'])assert.ok(document.included_sections.includes(required),`${domain}:${stage}:${document.criterion_id} must include antipattern ${required}`);}assert.equal(buildShadowKnowledgePacket(index,{batchId:domain,stage}).packet_hash,packet.packet_hash,'packet hash must be deterministic');}
assert.equal(packetKeys.length,24);const baseline=buildShadowKnowledgePacket(index,{batchId:'A',stage:'forensic_audit'});const changed={...index,documents:index.documents.map((document,index)=>index===0?{...document,sections:{...document.sections,canonical_definition:'changed governed content'}}:document)};assert.notEqual(buildShadowKnowledgePacket(changed,{batchId:'A',stage:'forensic_audit'}).packet_hash,baseline.packet_hash,'packet hash must change with governed packet content');
const missingRequired={...index,documents:index.documents.map((document,index)=>index===0?{...document,sections:{...document.sections,canonical_definition:''}}:document)};const invalidPacket=buildShadowKnowledgePacket(missingRequired,{batchId:'A',stage:'forensic_audit'});assert.equal(invalidPacket.readiness,'NOT_READY');assert.ok(invalidPacket.missing_requirements.includes('A1:canonical_definition'));
const runtimeContextSource=kbSource.slice(kbSource.indexOf('async fetchReferenceKnowledgeBaseContext'),kbSource.indexOf('async fetchStrategicPlaybook'));
const fallbackCondition=runtimeContextSource.slice(runtimeContextSource.indexOf('if (index.status.source'),runtimeContextSource.indexOf('return formatRemoteKbContext'));
assert.doesNotMatch(fallbackCondition,/shadow_ready|shadowPacket\.readiness/,'future packet diagnostics must not gate runtime KB prompt selection');
assert.match(fallbackCondition,/index\.status\.source !== 'remote_blob'/);
assert.match(fallbackCondition,/index\.status\.failure_count > 0/);
console.log('scale readiness tests passed');
