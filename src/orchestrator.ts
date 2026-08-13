
import { generateBatchSystemInstruction, generateBatchUserPrompt, generateTargetedBatchUserPrompt } from './prompts';
import { BATCH_DEFINITIONS, BATCH_IDS, knowledgeBaseService } from './knowledge_base';
import { runStage, serverLog, RunContext, StageExecutionError } from './services/modelRouter';
import { StageId } from './models';
import { EvidenceCheckItem, EvidenceCheckResult, ImageInput, RoutedSourcePacket } from './types';
import {
  applyEvidenceCheckToBatch,
  BatchAuditResult,
  evidenceItemsNeedingRescan,
  mergeEvidenceCheckResults,
  runEvidenceCheck,
  summarizeEvidenceCheck
} from './services/evidenceCheckService';

const parseAiResponse = (text: string): any => {
  if (!text) return {};
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json/gi, '').replace(/```/g, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[FinOps Orchestrator] AI response contained no JSON object; content omitted by logging policy.");
    return {};
  }
  const jsonString = jsonMatch[0];
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("[FinOps Orchestrator] JSON parse failed; response content omitted by logging policy.");
    throw new Error("AI response was not valid JSON.");
  }
};

export interface Phase1SourcePackets {
  packets: Record<string, RoutedSourcePacket>;
}

export interface Phase1Result {
  phase_1_audit_logs: {
    maturity: Record<string, any>;
    antipattern: Record<string, any>;
  };
  evidence_check: EvidenceCheckResult;
  failed_batches: string[];
  models_used: string[];
  targeted_rescan_models_used: string[];
  evidence_check_models_used: string[];
  evidence_adjudication_models_used: string[];
}

const runSingleBatch = async (
  batchId: string,
  text: string,
  images: ImageInput[],
  ctx: RunContext,
  userPromptOverride?: string,
  stage: StageId = 'forensic_audit'
): Promise<BatchAuditResult & { model_used?: string }> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const systemInstruction = generateBatchSystemInstruction(batchId, definitions.title);
  const userPrompt = userPromptOverride || generateBatchUserPrompt(batchId, definitions);
  const referenceKbContext = await knowledgeBaseService.fetchReferenceKnowledgeBaseContext({
    batchId,
    maxDocChars: userPromptOverride ? 1000 : 1400,
    label: userPromptOverride ? 'targeted_rescan' : 'forensic_audit',
  });

  const userText = `${userPrompt}\n\n${referenceKbContext}\n\n<UNTRUSTED_CONTENT>\n${text}\n</UNTRUSTED_CONTENT>`;

  const response = await runStage(stage, {
    userText,
    systemInstruction,
    images,
  }, ctx);

  const parsed = parseAiResponse(response.text);
  return { ...parsed, model_used: response.modelUsed.id };
};

const packetForBatch = (
  batchId: string,
  sourcePackets?: Phase1SourcePackets
): { text: string; images: ImageInput[]; packet: RoutedSourcePacket } => {
  if (!sourcePackets) {
    throw new Error(`Governed source packets are required for batch ${batchId}.`);
  }
  const packet = sourcePackets?.packets?.[batchId];
  if (!packet) {
    throw new Error(`Governed source packet is missing for batch ${batchId}.`);
  }
  return { text: packet.text, images: packet.images, packet };
};

const mergeBatchResult = (base: BatchAuditResult, patch: BatchAuditResult): BatchAuditResult => ({
  maturity: { ...(base.maturity || {}), ...(patch.maturity || {}) },
  antipattern: { ...(base.antipattern || {}), ...(patch.antipattern || {}) },
});

const batchFailureCode = (error: unknown): string => {
  if (error instanceof StageExecutionError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('All models exhausted')) return 'MODELS_EXHAUSTED';
  if (message.includes('not valid JSON')) return 'INVALID_MODEL_OUTPUT';
  if (message.includes('empty result')) return 'EMPTY_MODEL_OUTPUT';
  return 'BATCH_PROCESSING_FAILED';
};

const unavailableEvidenceCheck = (batchId: string, failureCode: string): EvidenceCheckResult => {
  const items: EvidenceCheckItem[] = (['maturity', 'antipattern'] as const).flatMap(stream =>
    Array.from({ length: 5 }, (_, index) => ({
      stream,
      id: `${batchId}${index + 1}`,
      status: 'missing' as const,
      original_count: 0,
      verified_count: 0,
      rationale: 'Domain analysis was unavailable after retry; no evidence verdict was produced.',
      rescan_recommended: false,
      quote_supported: false,
      verification_unresolved: true,
      ...(stream === 'antipattern' ? {
        antipattern_absence_status: 'unknown_absent' as const,
        coverage_reason: 'Domain analysis was unavailable, so neither presence nor tested absence can be claimed.',
      } : {}),
    }))
  );
  return {
    ...summarizeEvidenceCheck(batchId, items, []),
    failed: true,
    failure_reason: `Domain analysis unavailable (${failureCode}).`,
  };
};

const feedbackForRescan = (items: EvidenceCheckItem[]): string => {
  return items
    .map(item => `${item.stream}.${item.id}: scanner=${item.original_count}, verifier=${item.verified_count}, status=${item.status}. ${item.rationale}`)
    .join('\n');
};

const runTargetedRescan = async (
  batchId: string,
  text: string,
  images: ImageInput[],
  ctx: RunContext,
  items: EvidenceCheckItem[]
): Promise<BatchAuditResult & { model_used?: string }> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const maturityIds = items.filter(i => i.stream === 'maturity').map(i => i.id);
  const antipatternIds = items.filter(i => i.stream === 'antipattern').map(i => i.id);
  const prompt = generateTargetedBatchUserPrompt(
    batchId,
    definitions,
    maturityIds,
    antipatternIds,
    feedbackForRescan(items)
  );
  return runSingleBatch(batchId, text, images, ctx, prompt, 'targeted_rescan');
};

export const runPhase1Audit = async (
  text: string,
  images: ImageInput[],
  onProgress: (completed: number, total: number, batchId?: string) => void,
  ctx: RunContext,
  sourcePackets?: Phase1SourcePackets
): Promise<Phase1Result> => {
  const batches = BATCH_IDS;
  const totalBatches = batches.length;

  const aggregated: Phase1Result = {
    phase_1_audit_logs: { maturity: {}, antipattern: {} },
    evidence_check: mergeEvidenceCheckResults([]),
    failed_batches: [],
    models_used: [],
    targeted_rescan_models_used: [],
    evidence_check_models_used: [],
    evidence_adjudication_models_used: [],
  };

  let completedCount = 0;
  const modelsSeen = new Set<string>();
  const targetedRescanModelsSeen = new Set<string>();
  const evidenceModelsSeen = new Set<string>();
  const evidenceAdjudicationModelsSeen = new Set<string>();
  const evidenceResults: EvidenceCheckResult[] = [];

  onProgress(0, totalBatches);

  const auditPromises = batches.map(async (batchId) => {
    const batchStarted = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const packetInput = packetForBatch(batchId, sourcePackets);
        serverLog(ctx.runId, packetInput.packet.weak_coverage ? 'warn' : 'info', 'source_packet_used', {
          batch: batchId,
          chunks: packetInput.packet.included_chunk_count,
          candidates: packetInput.packet.total_candidate_chunks,
          weak_coverage: packetInput.packet.weak_coverage,
          fallback: 'none',
          chars: packetInput.text.length,
          images: packetInput.images.length,
        });

        let batchResult = await runSingleBatch(batchId, packetInput.text, packetInput.images, ctx);
        if (!batchResult.maturity && !batchResult.antipattern) {
          throw new Error('Batch returned empty result (no maturity or antipattern keys).');
        }
        if (batchResult.model_used) modelsSeen.add(batchResult.model_used);

        let evidenceCheck = await runEvidenceCheck(batchId, batchResult, packetInput.text, packetInput.images, ctx);
        if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
        if (evidenceCheck.adjudication_model_used) evidenceAdjudicationModelsSeen.add(evidenceCheck.adjudication_model_used);
        const needsRescan = evidenceItemsNeedingRescan(evidenceCheck);
        const rescannedKeys = new Set<string>();
        const preRescanCounts = new Map<string, number>();

        if (!evidenceCheck.failed && needsRescan.length > 0) {
          serverLog(ctx.runId, 'warn', 'evidence_check_targeted_rescan', {
            batch: batchId,
            criteria_count: needsRescan.length,
          });
          const rescanResult = await runTargetedRescan(batchId, packetInput.text, packetInput.images, ctx, needsRescan);
          if (rescanResult.model_used) {
            targetedRescanModelsSeen.add(rescanResult.model_used);
            serverLog(ctx.runId, 'info', 'targeted_rescan_model_used', {
              batch: batchId,
              model: rescanResult.model_used,
              criteria_count: needsRescan.length,
            });
          }
          batchResult = mergeBatchResult(batchResult, rescanResult) as BatchAuditResult & { model_used?: string };
          needsRescan.forEach(i => {
            const key = `${i.stream}.${i.id}`;
            rescannedKeys.add(key);
            preRescanCounts.set(key, i.original_count);
          });

          evidenceCheck = await runEvidenceCheck(batchId, batchResult, packetInput.text, packetInput.images, ctx);
          if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
          if (evidenceCheck.adjudication_model_used) evidenceAdjudicationModelsSeen.add(evidenceCheck.adjudication_model_used);
        }

        if (evidenceCheck.items.length > 0) {
          const evidenceFailure = evidenceCheck.failed;
          const evidenceFailureReason = evidenceCheck.failure_reason;
          const checked = applyEvidenceCheckToBatch(batchResult, evidenceCheck, rescannedKeys);
          batchResult = checked.batch as BatchAuditResult & { model_used?: string };
          const adjustments = checked.adjustments.map(a => {
            const original = preRescanCounts.get(`${a.stream}.${a.id}`);
            return original === undefined ? a : { ...a, original_count: original };
          });
          evidenceCheck = {
            ...summarizeEvidenceCheck(batchId, evidenceCheck.items, adjustments),
            model_used: evidenceCheck.model_used,
            adjudication_model_used: evidenceCheck.adjudication_model_used,
            failed: evidenceFailure,
            failure_reason: evidenceFailureReason,
          };
        }
        evidenceResults.push(evidenceCheck);

        if (batchResult.maturity) Object.assign(aggregated.phase_1_audit_logs.maturity, batchResult.maturity);
        if (batchResult.antipattern) Object.assign(aggregated.phase_1_audit_logs.antipattern, batchResult.antipattern);
        serverLog(ctx.runId, 'info', 'batch_complete', {
          batch: batchId,
          attempt,
          model: batchResult.model_used,
          evidence_check_model: evidenceCheck.model_used || 'n/a',
          evidence_adjudication_model: evidenceCheck.adjudication_model_used || 'n/a',
          evidence_downgrades: evidenceCheck.downgraded_count,
          evidence_rescans: evidenceCheck.rescan_count,
          duration_ms: Date.now() - batchStarted,
        });
        lastError = null;
        break;
      } catch (error: any) {
        lastError = error;
        const errorCode = batchFailureCode(error);
        console.warn(`[FinOps] [${ctx.runId}] Batch ${batchId} attempt ${attempt} failed with error_code=${errorCode}.`);
        serverLog(ctx.runId, 'warn', 'batch_attempt_failed', {
          batch: batchId,
          attempt,
          error_code: errorCode,
        });
      }
    }
    if (lastError) {
      const errorCode = batchFailureCode(lastError);
      console.error(`[FinOps] [${ctx.runId}] Batch ${batchId} failed after retry. Marking as failed.`);
      aggregated.failed_batches.push(batchId);
      evidenceResults.push(unavailableEvidenceCheck(batchId, errorCode));
      serverLog(ctx.runId, 'error', 'batch_failed', { batch: batchId, error_code: errorCode });
    }
    completedCount++;
    onProgress(completedCount, totalBatches, batchId);
  });

  await Promise.all(auditPromises);
  aggregated.models_used = Array.from(modelsSeen);
  aggregated.targeted_rescan_models_used = Array.from(targetedRescanModelsSeen);
  aggregated.evidence_check_models_used = Array.from(evidenceModelsSeen);
  aggregated.evidence_adjudication_models_used = Array.from(evidenceAdjudicationModelsSeen);
  aggregated.evidence_check = mergeEvidenceCheckResults(evidenceResults.sort((a, b) => (a.batch_id || '').localeCompare(b.batch_id || '')));
  return aggregated;
};
