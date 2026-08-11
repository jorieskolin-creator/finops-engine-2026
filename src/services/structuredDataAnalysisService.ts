import type { DataSignalRegistryEntry, DerivedAnalyticalEvidence, SourceRecord, StructuredTableData } from '../types';

export const DATA_SIGNAL_REGISTRY_VERSION = 'data_signal_registry_v1' as const;
export const TAGGING_ALLOCATION_ANALYZER_VERSION = '1.0.0' as const;

const targets=Object.freeze([Object.freeze({stream:'maturity' as const,criterion_id:'A1' as const}),Object.freeze({stream:'antipattern' as const,criterion_id:'A1' as const})]);
export const DATA_SIGNAL_REGISTRY: readonly DataSignalRegistryEntry[] = Object.freeze([
  Object.freeze({ signal_id:'ownership_mapping', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['owner','cost_center','product','application','environment']) }),
  Object.freeze({ signal_id:'tagging_coverage', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['tag','tags','label','labels']) }),
  Object.freeze({ signal_id:'allocation_coverage', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['allocation','allocated','cost_center','billing_account']) })
]);

const normalizeHeader=(value:string):string=>value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const matches=(header:string,patterns:readonly string[]):boolean=>patterns.some(pattern=>header===pattern||header.startsWith(`${pattern}_`)||header.endsWith(`_${pattern}`)||header.includes(`_${pattern}_`));
const populated=(value:string|undefined):boolean=>Boolean(value&&value.trim()&&!/^(null|n\/a|na|none|unknown|unallocated|untagged)$/i.test(value.trim()));
const percent=(count:number,total:number):number|null=>total>0?Math.round((count/total)*100):null;
const hash=(value:string):string=>{let h=0x811c9dc5;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193);}return(h>>>0).toString(16).padStart(8,'0');};

const coverageFor=(table:StructuredTableData,indexes:number[]):number|null=>{
  if(indexes.length===0||table.rows.length===0)return null;
  return percent(table.rows.filter(row=>indexes.some(index=>populated(row[index]))).length,table.rows.length);
};

export const analyzeTaggingAllocationTable=(source:SourceRecord):DerivedAnalyticalEvidence|null=>{
  const table=source.structured_table;
  if(!table)return null;
  const headers=table.headers.map(normalizeHeader);
  const mappingIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[0].canonical_fields)?[index]:[]);
  const taggingIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[1].canonical_fields)?[index]:[]);
  const allocationIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[2].canonical_fields)?[index]:[]);
  const detectedSignalCount=[mappingIndexes,taggingIndexes,allocationIndexes].filter(indexes=>indexes.length>0).length;
  const mappingCoverage=coverageFor(table,mappingIndexes);
  const taggingCoverage=coverageFor(table,taggingIndexes);
  const allocationCoverage=coverageFor(table,allocationIndexes);
  const schemaVersion='derived_analytical_evidence_v1' as const;
  const analyzerId='tagging_allocation_v1' as const;
  const method='tagging_allocation_coverage_analysis' as const;
  const signature=[schemaVersion,analyzerId,TAGGING_ALLOCATION_ANALYZER_VERSION,DATA_SIGNAL_REGISTRY_VERSION,method,source.source_id,hash(JSON.stringify(table))].join('|');
  return {
    schema_version:schemaVersion,mode:'shadow',evidence_id:`EVID-DER-${hash(signature)}`,
    evidence_type:'deterministic_analytical',source_id:source.source_id,
    targets:[{stream:'maturity',criterion_id:'A1'},{stream:'antipattern',criterion_id:'A1'}],
    derivation:{analyzer_id:analyzerId,analyzer_version:TAGGING_ALLOCATION_ANALYZER_VERSION,registry_version:DATA_SIGNAL_REGISTRY_VERSION,method},
    result:{status:detectedSignalCount>0&&table.rows.length>0?'OBSERVED':'INSUFFICIENT_SIGNAL',source_row_count:table.total_row_count,analyzed_row_count:table.rows.length,row_scope:table.total_row_count>table.rows.length?'bounded_prefix':'full_table',row_truncated:table.truncated,detected_signal_count:detectedSignalCount,mapping_population_coverage:mappingCoverage,tagging_population_coverage:taggingCoverage,allocation_population_coverage:allocationCoverage},
    raw_value_exposure:false
  };
};

export const analyzeStructuredSources=(sources:SourceRecord[]):DerivedAnalyticalEvidence[]=>sources.map(analyzeTaggingAllocationTable).filter((value):value is DerivedAnalyticalEvidence=>Boolean(value));
