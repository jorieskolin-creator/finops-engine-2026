import type { BoundedRetrievalTrace, RoutedSourcePacket, SourceChunk, SourceRegistry } from '../types';
import { rankedDomainCandidates } from './sourceRegistryService';

const MAX_PASSES=2 as const;
const MINIMUM_GAIN_POINTS=5 as const;
const MAX_SELECTIONS_PER_PASS=8;
const NEUTRAL_GAP_TERMS=['owner','ownership','enforce','enforcement','exception','execution','review','evidence','policy','process','control'];
const DOMAIN_EXPANSION_TERMS:Record<string,string[]>={A:['mapping','label','attribution','showback','chargeback'],B:['discount','commitment','capacity','consumption','idle'],C:['governance','approval','budget','forecast','compliance'],D:['design','platform','infrastructure','scaling','architecture'],E:['accountability','training','collaboration','incentive','organization'],F:['model','inference','token','gateway','ai spend']};
const percent=(count:number,total:number):number=>total>0?Math.round((count/total)*100):0;
const hasNeutralGapSignal=(chunk:SourceChunk,domainId:string):boolean=>{const text=chunk.text.toLowerCase();return NEUTRAL_GAP_TERMS.some(term=>text.includes(term))&&(DOMAIN_EXPANSION_TERMS[domainId]||[]).some(term=>text.includes(term));};

export const buildBoundedRetrievalTrace=(registry:SourceRegistry,packets:Record<string,RoutedSourcePacket>):BoundedRetrievalTrace=>({
  schema_version:'bounded_retrieval_trace_v1',policy_version:'bounded_retrieval_policy_v1',mode:'shadow',max_passes:MAX_PASSES,minimum_gain_points:MINIMUM_GAIN_POINTS,
  domains:Object.keys(packets).sort().map(domainId=>{
    const packet=packets[domainId];
    const selected=new Set(packet.manifest.map(item=>item.chunk_id));
    const routed=rankedDomainCandidates(registry,domainId).map(item=>item.chunk);const routedIds=new Set(routed.map(chunk=>chunk.chunk_id));
    const expansion=registry.chunks.filter(chunk=>!routedIds.has(chunk.chunk_id)&&hasNeutralGapSignal(chunk,domainId)).sort((a,b)=>a.chunk_id.localeCompare(b.chunk_id));
    const eligibleIds=new Set([...routed,...expansion].map(chunk=>chunk.chunk_id));
    const coverage=()=>percent([...selected].filter(id=>eligibleIds.has(id)).length,eligibleIds.size);
    const baselineCoverage=coverage();
    const passes:BoundedRetrievalTrace['domains'][number]['passes']=[];
    if(!packet.weak_coverage)return{domain_id:domainId,baseline_coverage:baselineCoverage,final_coverage:baselineCoverage,stop_reason:'SUFFICIENT_BASELINE' as const,passes};
    const runPass=(pass:1|2,strategy:'omitted_routed_candidates'|'neutral_gap_expansion',candidates:SourceChunk[])=>{
      const before=coverage();const additions=candidates.filter(chunk=>!selected.has(chunk.chunk_id)).slice(0,MAX_SELECTIONS_PER_PASS);additions.forEach(chunk=>selected.add(chunk.chunk_id));const after=coverage();passes.push({pass,strategy,coverage_before:before,coverage_after:after,gain_points:after-before,candidate_count:candidates.filter(chunk=>!packet.manifest.some(item=>item.chunk_id===chunk.chunk_id)).length,selected_chunk_ids:additions.map(chunk=>chunk.chunk_id)});return{additions,gain:after-before};
    };
    const first=runPass(1,'omitted_routed_candidates',routed);
    if(first.additions.length>0&&first.gain<MINIMUM_GAIN_POINTS)return{domain_id:domainId,baseline_coverage:baselineCoverage,final_coverage:coverage(),stop_reason:'MINIMUM_GAIN_NOT_MET' as const,passes};
    const second=runPass(2,'neutral_gap_expansion',expansion);
    const stopReason=second.additions.length===0?'NO_NEW_CANDIDATES' as const:second.gain<MINIMUM_GAIN_POINTS?'MINIMUM_GAIN_NOT_MET' as const:'MAX_PASSES_REACHED' as const;
    return{domain_id:domainId,baseline_coverage:baselineCoverage,final_coverage:coverage(),stop_reason:stopReason,passes};
  })
});
