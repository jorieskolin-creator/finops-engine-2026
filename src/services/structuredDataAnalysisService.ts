import type { DataSignalCoverageReport, DataSignalRegistryEntry, DerivedAnalyticalEvidence, EvidenceAnalysisRegistryEntry, SourceRecord, StructuredTableData } from '../types';

export const DATA_SIGNAL_REGISTRY_VERSION = 'data_signal_registry_v1' as const;
export const TAGGING_ALLOCATION_ANALYZER_VERSION = '1.1.0' as const;
export const EVIDENCE_ANALYSIS_REGISTRY_VERSION = 'evidence_analysis_registry_v1' as const;

const targets=Object.freeze([Object.freeze({stream:'maturity' as const,criterion_id:'A1' as const}),Object.freeze({stream:'antipattern' as const,criterion_id:'A1' as const})]);
export const DATA_SIGNAL_REGISTRY: readonly DataSignalRegistryEntry[] = Object.freeze([
  Object.freeze({ signal_id:'ownership_mapping', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['owner','cost_center','product','application','environment']) }),
  Object.freeze({ signal_id:'tagging_coverage', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['tag','tags','label','labels']) }),
  Object.freeze({ signal_id:'allocation_coverage', analyzer_id:'tagging_allocation_v1' as const, targets, canonical_fields:Object.freeze(['allocation','allocated','cost_center','billing_account']) })
]);

export const EVIDENCE_ANALYSIS_REGISTRY: readonly EvidenceAnalysisRegistryEntry[] = Object.freeze([
  Object.freeze({
    analyzer_id: 'tagging_allocation_v1' as const,
    analyzer_version: TAGGING_ALLOCATION_ANALYZER_VERSION,
    registry_version: EVIDENCE_ANALYSIS_REGISTRY_VERSION,
    approval_status: 'SHADOW_ONLY' as const,
    approved_for_model_packet: false,
    accepted_source_kinds: Object.freeze(['csv', 'tsv', 'xlsx'] as const),
    targets,
    calculations: Object.freeze([
      Object.freeze({ calculation_id:'field_row_coverage', formula:'valid eligible rows / all eligible non-total rows * 100', output_fields:Object.freeze(['field_coverage[].eligible_row_count','field_coverage[].valid_row_count','field_coverage[].row_coverage_percent','field_coverage[].state']), eligibility_rule:'A recognized canonical field is present and the complete eligible row population is available.' }),
      Object.freeze({ calculation_id:'field_cost_coverage', formula:'eligible cost with a valid field assignment / total eligible cost * 100', output_fields:Object.freeze(['field_coverage[].eligible_cost','field_coverage[].valid_cost','field_coverage[].cost_coverage_percent']), eligibility_rule:'Exactly one recognized cost column is parseable and currency semantics are not ambiguous.' }),
      Object.freeze({ calculation_id:'invalid_placeholder_count', formula:'count eligible rows containing a registry-defined invalid placeholder', output_fields:Object.freeze(['field_coverage[].invalid_placeholder_count']), eligibility_rule:'A recognized canonical field is present.' }),
      Object.freeze({ calculation_id:'uncovered_cost', formula:'sum eligible cost for rows without a valid field assignment', output_fields:Object.freeze(['field_coverage[].uncovered_cost','field_coverage[].top_uncovered_contributors']), eligibility_rule:'Cost basis is VALID and a recognized canonical field is present.' }),
      Object.freeze({ calculation_id:'valid_value_cardinality', formula:'distinct normalized valid field values / rows with a valid field value * 100', output_fields:Object.freeze(['field_coverage[].distinct_valid_value_count','field_coverage[].valid_value_cardinality_percent']), eligibility_rule:'A recognized canonical field is present; this is an indicator, not a taxonomy-quality conclusion.' }),
      Object.freeze({ calculation_id:'conflicting_assignment_count', formula:'count stable entity keys mapped to more than one distinct valid field value', output_fields:Object.freeze(['field_coverage[].conflicting_assignment_count']), eligibility_rule:'Exactly one recognized stable entity-key column and a recognized canonical field are present.' }),
      Object.freeze({ calculation_id:'cost_basis_validation', formula:'classify cost column as NOT_PRESENT, VALID, AMBIGUOUS_CURRENCY or INVALID_VALUES', output_fields:Object.freeze(['result.cost_basis']), eligibility_rule:'Applied to every analyzed table; no cross-currency aggregation is permitted.' }),
      Object.freeze({ calculation_id:'source_total_reconciliation', formula:'sum parsed eligible non-total cost - single declared total', output_fields:Object.freeze(['result.reconciliation']), eligibility_rule:'Exactly one parseable cost column and at most one declared total row are present.' })
    ]),
    forbidden_interpretations: Object.freeze([
      'Do not infer culture, collaboration quality or process maturity from table population metrics.',
      'Do not equate a missing field with a verified zero.',
      'Do not aggregate ambiguous currencies.',
      'Do not use bounded-prefix results as full-population evidence.',
      'Do not let a model recalculate or override deterministic outputs.'
    ])
  })
]);

export const isDerivedEvidenceApprovedForPacket = (evidence: DerivedAnalyticalEvidence): boolean =>
  EVIDENCE_ANALYSIS_REGISTRY.some(entry =>
    entry.analyzer_id === evidence.derivation.analyzer_id
    && entry.analyzer_version === evidence.derivation.analyzer_version
    && entry.registry_version === evidence.derivation.registry_version
    && entry.approval_status === 'APPROVED'
    && entry.approved_for_model_packet
    && evidence.schema_version === 'derived_analytical_evidence_v1'
    && evidence.mode === 'authoritative'
    && evidence.report_eligible
    && evidence.raw_value_exposure === false
    && evidence.result.status === 'OBSERVED'
    && evidence.result.row_scope === 'full_table'
    && !evidence.result.row_truncated
    && /^[a-f0-9]{8}$/.test(evidence.unit_fingerprint)
  );

export const buildDataSignalCoverageReport=():DataSignalCoverageReport=>{
  const objects:DataSignalCoverageReport['objects']=[];
  for(const domainId of ['A','B','C','D','E','F'])for(let index=1;index<=5;index++)for(const stream of ['maturity','antipattern'] as const){
    const internalId=`${domainId}${index}`;
    const analyzerIds=[...new Set(DATA_SIGNAL_REGISTRY.filter(entry=>entry.targets.some(target=>target.stream===stream&&target.criterion_id===internalId)).map(entry=>entry.analyzer_id))].sort();
    objects.push({domain_id:domainId,stream,criterion_id:stream==='antipattern'?`AP-${internalId}`:internalId,status:analyzerIds.length?'SHADOW_ANALYZER_AVAILABLE':'NO_AUTHORITATIVE_ANALYZER_SEMANTICS',analyzer_ids:analyzerIds});
  }
  const analyzerAvailableCount=objects.filter(object=>object.status==='SHADOW_ANALYZER_AVAILABLE').length;
  return{schema_version:'data_signal_coverage_v1',registry_version:DATA_SIGNAL_REGISTRY_VERSION,mode:'shadow',total_object_count:60,analyzer_available_count:analyzerAvailableCount,unsupported_count:60-analyzerAvailableCount,objects};
};

const normalizeHeader=(value:string):string=>value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const matches=(header:string,patterns:readonly string[]):boolean=>patterns.some(pattern=>header===pattern||header.startsWith(`${pattern}_`)||header.endsWith(`_${pattern}`)||header.includes(`_${pattern}_`));
const INVALID_PLACEHOLDER=/^(?:null|n\/a|na|none|unknown|unallocated|unassigned|untagged|tbd|shared|-)$/i;
const populated=(value:string|undefined):boolean=>Boolean(value&&value.trim()&&!INVALID_PLACEHOLDER.test(value.trim()));
const percent=(count:number,total:number):number|null=>total>0?Math.round((count/total)*100):null;
const hash=(value:string):string=>{let h=0x811c9dc5;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193);}return(h>>>0).toString(16).padStart(8,'0');};
const rounded=(value:number):number=>Math.round(value*100)/100;

const analysisRows=(table:StructuredTableData):string[][]=>table.analysis_rows||table.rows;
const coverageFor=(rows:string[][],indexes:number[]):number|null=>{
  if(indexes.length===0||rows.length===0)return null;
  return percent(rows.filter(row=>indexes.some(index=>populated(row[index]))).length,rows.length);
};

const fieldPatterns={
  owner:['owner'],cost_center:['cost_center','costcentre'],product:['product'],application:['application','app'],environment:['environment','env'],
  tagging:['tag','tags','label','labels'],allocation:['allocation','allocated','cost_center','costcentre','billing_account']
} as const;
type CoverageField=keyof typeof fieldPatterns;
const costPatterns=['cost','spend','amount','net_cost','amortized_cost','unblended_cost','effective_cost'] as const;
const entityPatterns=['resource_id','resourceid','instance_id','account_id','subscription_id','project_id','workload_id'] as const;
const matchesCost=(header:string):boolean=>costPatterns.includes(header as typeof costPatterns[number])||/(?:_cost|_spend|_amount)$/.test(header);
const totalRow=(row:string[]):boolean=>row.slice(0,3).some(value=>/^(?:grand\s+)?(?:sub)?total$/i.test(value.trim()));
const parseCost=(value:string|undefined):number|null=>{
  if(!value||/%/.test(value))return null;
  const normalized=value.trim().replace(/[A-Z]{3}/gi,'').replace(/[$€£¥,\s]/g,'');
  const signed=/^\(.*\)$/.test(normalized)?`-${normalized.slice(1,-1)}`:normalized;
  if(!/^-?\d+(?:\.\d+)?$/.test(signed))return null;
  const parsed=Number(signed);return Number.isFinite(parsed)&&parsed>=0?parsed:null;
};
const currenciesFor=(header:string,rows:string[][],index:number):string[]=>{
  const values=[header,...rows.map(row=>row[index]||'')].join(' ');const found=new Set<string>();
  if(/\$/.test(values))found.add('USD_OR_DOLLAR');if(/€/.test(values))found.add('EUR');if(/£/.test(values))found.add('GBP');if(/¥/.test(values))found.add('JPY_OR_CNY');
  for(const match of values.matchAll(/\b(USD|EUR|GBP|JPY|CNY|CAD|AUD)\b/gi))found.add(match[1].toUpperCase());if(found.has('USD'))found.delete('USD_OR_DOLLAR');return[...found].sort();
};

export const analyzeTaggingAllocationTable=(source:SourceRecord, tableOverride?:StructuredTableData):DerivedAnalyticalEvidence|null=>{
  const table=tableOverride||source.structured_table;
  if(!table)return null;
  const rows=analysisRows(table);
  const headers=table.headers.map(normalizeHeader);
  const mappingIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[0].canonical_fields)?[index]:[]);
  const taggingIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[1].canonical_fields)?[index]:[]);
  const allocationIndexes=headers.flatMap((header,index)=>matches(header,DATA_SIGNAL_REGISTRY[2].canonical_fields)?[index]:[]);
  const detectedSignalCount=[mappingIndexes,taggingIndexes,allocationIndexes].filter(indexes=>indexes.length>0).length;
  const eligibleRows=rows.filter(row=>!totalRow(row));
  const mappingCoverage=coverageFor(eligibleRows,mappingIndexes);
  const taggingCoverage=coverageFor(eligibleRows,taggingIndexes);
  const allocationCoverage=coverageFor(eligibleRows,allocationIndexes);
  const declaredTotalRows=rows.filter(totalRow);
  const costIndexes=headers.flatMap((header,index)=>matchesCost(header)?[index]:[]);
  const costIndex=costIndexes.length===1?costIndexes[0]:null;
  const currencies=costIndex===null?[]:currenciesFor(table.headers[costIndex]||'',eligibleRows,costIndex);
  const parsedCosts=eligibleRows.map(row=>costIndex===null?null:parseCost(row[costIndex]));
  const validCosts=parsedCosts.filter((value):value is number=>value!==null);
  const excludedCostRows=parsedCosts.length-validCosts.length;
  const costState=costIndex===null?'NOT_PRESENT' as const:currencies.length>1?'AMBIGUOUS_CURRENCY' as const:excludedCostRows>0||validCosts.length===0?'INVALID_VALUES' as const:'VALID' as const;
  const costWeightEligible=costState==='VALID'&&validCosts.length>0;
  const eligibleCost=costWeightEligible?validCosts.reduce((sum,value)=>sum+value,0):null;
  const eligibleRowNumbers=(table.analysis_row_numbers||table.sampled_row_numbers||rows.map((_,index)=>index+1)).filter((_,index)=>!totalRow(rows[index]||[]));
  const entityIndexes=headers.flatMap((header,index)=>matches(header,entityPatterns)?[index]:[]);
  const fieldCoverage=(Object.keys(fieldPatterns) as CoverageField[]).map(field=>{
    const indexes=headers.flatMap((header,index)=>matches(header,fieldPatterns[field])?[index]:[]);
    const validRows=eligibleRows.filter(row=>indexes.some(index=>populated(row[index])));
    const invalidPlaceholderCount=eligibleRows.filter(row=>indexes.some(index=>Boolean(row[index]?.trim())&&INVALID_PLACEHOLDER.test(row[index].trim()))).length;
    const fieldEligibleCost=indexes.length>0?eligibleCost:null;
    const validCost=indexes.length>0&&costWeightEligible?eligibleRows.reduce((sum,row,index)=>indexes.some(column=>populated(row[column]))?sum+(parsedCosts[index]||0):sum,0):null;
    const uncoveredCost=fieldEligibleCost!==null&&validCost!==null?rounded(fieldEligibleCost-validCost):null;
    const validValues=eligibleRows.flatMap(row=>indexes.map(index=>row[index]?.trim()).filter((value):value is string=>populated(value)));
    const distinctValidValueCount=indexes.length>0?new Set(validValues.map(value=>value.toLowerCase())).size:null;
    const cardinalityPercent=distinctValidValueCount!==null&&validRows.length>0?rounded(distinctValidValueCount/validRows.length*100):null;
    let conflictingAssignmentCount:number|null=null;
    if(indexes.length>0&&entityIndexes.length===1){const assignments=new Map<string,Set<string>>();for(const row of eligibleRows){const entity=row[entityIndexes[0]]?.trim().toLowerCase();if(!entity)continue;const values=indexes.map(index=>row[index]?.trim()).filter((value):value is string=>populated(value)).map(value=>value.toLowerCase());if(!values.length)continue;const set=assignments.get(entity)||new Set<string>();values.forEach(value=>set.add(value));assignments.set(entity,set);}conflictingAssignmentCount=[...assignments.values()].filter(values=>values.size>1).length;}
    const topUncoveredContributors=indexes.length>0&&costWeightEligible&&eligibleCost
      ?eligibleRows.flatMap((row,index)=>indexes.some(column=>populated(row[column]))||parsedCosts[index]===null?[]:[{row_number:eligibleRowNumbers[index]||index+1,cost:rounded(parsedCosts[index]!),eligible_cost_percent:rounded(parsedCosts[index]!/eligibleCost*100)}]).sort((a,b)=>b.cost-a.cost||a.row_number-b.row_number).slice(0,5)
      :[];
    const singular=!['tagging','allocation'].includes(field);
    const state=indexes.length===0?'FIELD_NOT_PRESENT' as const
      :eligibleRows.length===0?'INSUFFICIENT_COVERAGE' as const
      :singular&&indexes.length>1?'FIELD_PRESENT_AMBIGUOUS' as const
      :validRows.length===0&&invalidPlaceholderCount>0?'FIELD_PRESENT_INVALID' as const
      :validRows.length===0?'FIELD_PRESENT_EMPTY' as const
      :validRows.length<eligibleRows.length?'FIELD_PRESENT_PARTIAL' as const
      :'FIELD_PRESENT_VALID' as const;
    return{field,state,column_indexes:indexes,eligible_row_count:eligibleRows.length,valid_row_count:validRows.length,invalid_placeholder_count:invalidPlaceholderCount,row_coverage_percent:indexes.length>0?percent(validRows.length,eligibleRows.length):null,eligible_cost:fieldEligibleCost===null?null:rounded(fieldEligibleCost),valid_cost:validCost===null?null:rounded(validCost),uncovered_cost:uncoveredCost,cost_coverage_percent:fieldEligibleCost&&validCost!==null?rounded(validCost/fieldEligibleCost*100):null,distinct_valid_value_count:distinctValidValueCount,valid_value_cardinality_percent:cardinalityPercent,conflicting_assignment_count:conflictingAssignmentCount,top_uncovered_contributors:topUncoveredContributors};
  });
  const calculatedTotal=eligibleCost;
  const declaredTotals=costIndex===null?[]:declaredTotalRows.map(row=>parseCost(row[costIndex])).filter((value):value is number=>value!==null);
  const declaredTotal=declaredTotals.length===1?declaredTotals[0]:null;
  const difference=calculatedTotal!==null&&declaredTotal!==null?rounded(calculatedTotal-declaredTotal):null;
  const reconciliationState=declaredTotals.length>1?'AMBIGUOUS' as const:declaredTotal===null||calculatedTotal===null?'NOT_AVAILABLE' as const:Math.abs(difference||0)<=0.01?'PASSED' as const:'FAILED' as const;
  const schemaVersion='derived_analytical_evidence_v1' as const;
  const analyzerId='tagging_allocation_v1' as const;
  const method='tagging_allocation_coverage_analysis' as const;
  const calculationIds=EVIDENCE_ANALYSIS_REGISTRY[0].calculations.map(calculation=>calculation.calculation_id);
  const eligibilityReasons=[
    'REGISTRY_SHADOW_ONLY',
    ...(table.analysis_complete===false||rows.length<table.total_row_count?['INCOMPLETE_POPULATION']:[]),
    ...(reconciliationState==='FAILED'?['RECONCILIATION_FAILED']:[]),
    ...(costState==='AMBIGUOUS_CURRENCY'?['AMBIGUOUS_CURRENCY']:[])
  ];
  const signature=[schemaVersion,analyzerId,TAGGING_ALLOCATION_ANALYZER_VERSION,EVIDENCE_ANALYSIS_REGISTRY_VERSION,method,source.source_id,hash(JSON.stringify(table))].join('|');
  return {
    schema_version:schemaVersion,mode:'shadow',evidence_id:`EVID-DER-${hash(signature)}`,
    evidence_type:'deterministic_analytical',source_id:source.source_id,
    targets:[{stream:'maturity',criterion_id:'A1'},{stream:'antipattern',criterion_id:'A1'}],
    derivation:{analyzer_id:analyzerId,analyzer_version:TAGGING_ALLOCATION_ANALYZER_VERSION,registry_version:EVIDENCE_ANALYSIS_REGISTRY_VERSION,method,calculation_ids:calculationIds},
    result:{status:detectedSignalCount>0&&rows.length>0?'OBSERVED':'INSUFFICIENT_SIGNAL',source_row_count:table.total_row_count,analyzed_row_count:rows.length,eligible_row_count:eligibleRows.length,excluded_total_row_count:declaredTotalRows.length,row_scope:rows.length<table.total_row_count?'bounded_prefix':'full_table',row_truncated:table.analysis_complete===false||rows.length<table.total_row_count,detected_signal_count:detectedSignalCount,mapping_population_coverage:mappingCoverage,tagging_population_coverage:taggingCoverage,allocation_population_coverage:allocationCoverage,field_coverage:fieldCoverage,cost_basis:{state:costState,column_index:costIndex,currencies,excluded_row_count:excludedCostRows},reconciliation:{state:reconciliationState,calculated_total:calculatedTotal===null?null:rounded(calculatedTotal),declared_total:declaredTotal===null?null:rounded(declaredTotal),difference}},
    locator:{sheet:table.sheet_name,range:table.source_range,header_row:table.header_row_number},eligibility:{state:'SHADOW_ONLY',reasons:eligibilityReasons},unit_fingerprint:hash(JSON.stringify(table)),report_eligible:false,
    raw_value_exposure:false
  };
};

export const analyzeStructuredSources=(sources:SourceRecord[]):DerivedAnalyticalEvidence[]=>sources.flatMap(source=>{
  const tables=source.structured_tables?.filter(table=>table.model_eligible) || (source.structured_table?[source.structured_table]:[]);
  return tables.map(table=>analyzeTaggingAllocationTable(source,table)).filter((value):value is DerivedAnalyticalEvidence=>Boolean(value));
});
