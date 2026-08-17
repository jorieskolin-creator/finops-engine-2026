import type { DiagnosticResult } from '../types';
import { listCheckpoints, loadCheckpoint, type CheckpointKind, type CheckpointMetadata } from './checkpointService';
import { applyQualityGateScoreCap } from './metricsService';

const latest = (manifest: CheckpointMetadata[], kind: CheckpointKind, scope?: string): CheckpointMetadata | null => {
  const hashes = new Set(manifest.map(item => item.payload_hash));
  return manifest
    .filter(item => item.schema_version === 'checkpoint_v1' && item.kind === kind && (!scope || item.scope === scope))
    .filter(item => item.parent_hash === null || hashes.has(item.parent_hash))
    .sort((a, b) => b.revision - a.revision)[0] || null;
};

const read = async (runId: string, metadata: CheckpointMetadata | null): Promise<Record<string, any> | null> =>
  metadata ? (await loadCheckpoint<Record<string, any>>(runId, metadata.checkpoint_id)).payload : null;

const recoveredStrategy = (phase2: any): any => {
  const metrics = phase2?.metrics || {};
  const density = Math.round(Number(metrics.evidence_density) || 0);
  const readiness = Math.round(Number(metrics.finops_readiness) || 0);
  const silent = Array.isArray(phase2?.silent_areas) ? phase2.silent_areas : [];
  const gaps = Array.isArray(phase2?.maturity_gaps) ? phase2.maturity_gaps : [];
  const antipatterns = Array.isArray(phase2?.antipattern_findings) ? phase2.antipattern_findings : [];
  const summary = `The accepted analysis was recovered from temporary storage after pipeline interruption. Evidence density was ${density}% and the evidence-sensitive FinOps Maturity Score was ${readiness}/100. A full summary and roadmap cannot be safely reconstructed without a validated synthesis, so this recovery report is BLOCK / NO_GO.`;
  return {
    executive_summary: summary,
    executive_summaries: { finops_lead: summary, cfo: summary, engineering_lead: summary },
    active_persona: 'finops_lead',
    evidence_summary: {
      headline: 'Recovered analysis — insufficient validated synthesis',
      maturity_classification: phase2?.crawl_walk_run || 'Insufficient Evidence',
      key_metrics: [`FinOps Maturity Score: ${readiness}/100`, `Evidence density: ${density}%`],
      confirmed_strengths: [],
      confirmed_gaps: gaps.slice(0, 8),
      confirmed_antipatterns: antipatterns.slice(0, 8),
      silent_or_missing_evidence: silent.slice(0, 8),
    },
    diagnosis: {
      primary_bottleneck: gaps[0] || antipatterns[0] || 'Validated synthesis was unavailable.',
      root_causes: [...gaps, ...antipatterns].slice(0, 5),
      domain_diagnosis: {},
      confidence: 'low',
      confidence_rationale: 'Recovered from accepted deterministic Phase 1 and Phase 2 checkpoints; no replacement claims were generated.',
    },
    planning_decision: {
      decision: 'NO_GO',
      rationale: 'A validated synthesis and fact-check were not available at recovery time.',
      safe_to_act_on: ['Review the recovered findings and provide missing evidence before rerunning.'],
      evidence_needed_before_action: silent.slice(0, 8),
    },
    visual_scorecard: { headline: 'Recovered — Findings Only', maturity_score: `${readiness}/100`, burden_score: `${Math.round(Number(metrics.antipattern_burden) || 0)}%` },
    remediation_roadmap: [],
    confidence_bracket: 'LOW',
    effective_bracket: 'LOW',
  };
};

export async function recoverCheckpointResult(runId: string): Promise<{ result: DiagnosticResult; complete: boolean } | null> {
  const manifest = await listCheckpoints(runId);
  const finalPayload = await read(runId, latest(manifest, 'final_report', 'ready_for_delivery'));
  if (finalPayload?.result?.meta?.run_id === runId && finalPayload.result.phase_2_validation?.metrics) {
    return { result: finalPayload.result as DiagnosticResult, complete: true };
  }

  const phase1Payload = await read(runId, latest(manifest, 'phase1', 'accepted'));
  const phase2Payload = await read(runId, latest(manifest, 'phase2', 'accepted'));
  if (!phase1Payload?.phase_1_audit_logs || !phase2Payload?.phase_2_validation?.metrics) return null;
  const synthesisPayload = await read(runId, latest(manifest, 'synthesis', 'accepted'));
  const qualityPayload = await read(runId, latest(manifest, 'quality_gate', 'accepted'));
  const phase2 = phase2Payload.phase_2_validation;
  applyQualityGateScoreCap(phase2, 'BLOCK');
  const strategy = synthesisPayload?.phase_3_strategy
    ? JSON.parse(JSON.stringify(synthesisPayload.phase_3_strategy))
    : recoveredStrategy(phase2);
  strategy.remediation_roadmap = [];
  strategy.effective_bracket = 'LOW';
  strategy.planning_decision = {
    decision: 'NO_GO',
    rationale: 'The run was interrupted before a complete report reached the verified delivery boundary.',
    safe_to_act_on: ['Review recovered findings and provide missing evidence before rerunning.'],
    evidence_needed_before_action: Array.isArray(phase2.silent_areas) ? phase2.silent_areas.slice(0, 8) : [],
  };
  const result = {
    meta: {
      run_id: runId,
      document_analyzed: 'Recovered temporary assessment',
      timestamp: new Date().toISOString(),
      engine_version: '2.0.0',
      source_parse_warnings: ['The pipeline was interrupted. This report was reconstructed from hash-verified temporary checkpoints.'],
    },
    phase_1_audit_logs: phase1Payload.phase_1_audit_logs,
    evidence_check: phase1Payload.evidence_check,
    phase_2_validation: phase2,
    phase_3_strategy: strategy,
    quality_gate: {
      ...(qualityPayload?.quality_gate || {}),
      decision: 'BLOCK',
      blocking_reasons: [
        ...((qualityPayload?.quality_gate?.blocking_reasons || []).filter((reason: unknown): reason is string => typeof reason === 'string')),
        'Recovered run did not reach a complete validated delivery boundary.',
      ],
      warnings: [
        ...((qualityPayload?.quality_gate?.warnings || []).filter((warning: unknown): warning is string => typeof warning === 'string')),
        'No roadmap is authorized from this recovery report.',
      ],
      fact_check: qualityPayload?.quality_gate?.fact_check || { attempts: 0, total_claims: 0, supported_count: 0, unsupported_claims: [], failed: true, failure_reason: 'Pipeline interrupted before complete verification.' },
    },
  } as DiagnosticResult;
  return { result, complete: false };
}
