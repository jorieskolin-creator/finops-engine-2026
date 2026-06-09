
import { generateBatchSystemInstruction, generateBatchUserPrompt, generateTargetedBatchUserPrompt } from './prompts';
import { BATCH_DEFINITIONS, BATCH_IDS, knowledgeBaseService } from './knowledge_base';
import { runStage, serverLog, RunContext } from './services/modelRouter';
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
    console.warn("[FinOps Orchestrator] AI Response contained no JSON braces. Raw:", text.substring(0, 200));
    return {};
  }
  const jsonString = jsonMatch[0];
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("[FinOps Orchestrator] JSON Parse Failed. Raw Text:", text.substring(0, 500));
    throw new Error("AI response was not valid JSON.");
  }
};

export interface Phase1SourcePackets {
  packets: Record<string, RoutedSourcePacket>;
  fullText: string;
  fullImages: ImageInput[];
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
  text: string,
  images: ImageInput[],
  sourcePackets?: Phase1SourcePackets
): { text: string; images: ImageInput[]; packet?: RoutedSourcePacket; usedFallback: boolean } => {
  const packet = sourcePackets?.packets?.[batchId];
  if (!packet) return { text, images, usedFallback: false };
  if (packet.weak_coverage) {
    return {
      text: `<SOURCE_PACKET_WEAK_COVERAGE domain="${batchId}">
${packet.coverage_notes.join('\n')}
The domain packet was too thin, so this batch receives broad-source fallback below. Continue to cite exact source/chunk/page markers where available.
</SOURCE_PACKET_WEAK_COVERAGE>

${text}`,
      images,
      packet,
      usedFallback: true
    };
  }
  return { text: packet.text, images: packet.images, packet, usedFallback: false };
};

const mergeBatchResult = (base: BatchAuditResult, patch: BatchAuditResult): BatchAuditResult => ({
  maturity: { ...(base.maturity || {}), ...(patch.maturity || {}) },
  antipattern: { ...(base.antipattern || {}), ...(patch.antipattern || {}) },
});

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
  onProgress: (completed: number, total: number) => void,
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

  const auditPromises = batches.map(async (batchId) => {
    const batchStarted = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const packetInput = packetForBatch(batchId, text, images, sourcePackets);
        serverLog(ctx.runId, packetInput.usedFallback ? 'warn' : 'info', 'source_packet_used', {
          batch: batchId,
          chunks: packetInput.packet?.included_chunk_count ?? 'n/a',
          candidates: packetInput.packet?.total_candidate_chunks ?? 'n/a',
          weak_coverage: packetInput.packet?.weak_coverage ? 'yes' : 'no',
          fallback: packetInput.usedFallback ? 'broad_source' : 'packet',
          chars: packetInput.text.length,
          images: packetInput.images.length,
        });

        let batchResult = await runSingleBatch(batchId, packetInput.text, packetInput.images, ctx);
        if (!batchResult.maturity && !batchResult.antipattern) {
          throw new Error('Batch returned empty result (no maturity or antipattern keys).');
        }
        if (batchResult.model_used) modelsSeen.add(batchResult.model_used);

        const verifierFallbackText = packetInput.usedFallback ? undefined : sourcePackets?.fullText;
        let evidenceCheck = await runEvidenceCheck(batchId, batchResult, packetInput.text, packetInput.images, ctx, verifierFallbackText);
        if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
        if (evidenceCheck.adjudication_model_used) evidenceAdjudicationModelsSeen.add(evidenceCheck.adjudication_model_used);
        const needsRescan = evidenceItemsNeedingRescan(evidenceCheck);
        const rescannedKeys = new Set<string>();
        const preRescanCounts = new Map<string, number>();

        if (!evidenceCheck.failed && needsRescan.length > 0) {
          serverLog(ctx.runId, 'warn', 'evidence_check_targeted_rescan', {
            batch: batchId,
            criteria: needsRescan.map(i => `${i.stream}.${i.id}`).join(','),
          });
          const rescanResult = await runTargetedRescan(batchId, packetInput.text, packetInput.images, ctx, needsRescan);
          if (rescanResult.model_used) {
            targetedRescanModelsSeen.add(rescanResult.model_used);
            serverLog(ctx.runId, 'info', 'targeted_rescan_model_used', {
              batch: batchId,
              model: rescanResult.model_used,
              criteria: needsRescan.map(i => `${i.stream}.${i.id}`).join(','),
            });
          }
          batchResult = mergeBatchResult(batchResult, rescanResult) as BatchAuditResult & { model_used?: string };
          needsRescan.forEach(i => {
            const key = `${i.stream}.${i.id}`;
            rescannedKeys.add(key);
            preRescanCounts.set(key, i.original_count);
          });

          evidenceCheck = await runEvidenceCheck(batchId, batchResult, packetInput.text, packetInput.images, ctx, verifierFallbackText);
          if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
          if (evidenceCheck.adjudication_model_used) evidenceAdjudicationModelsSeen.add(evidenceCheck.adjudication_model_used);
        }

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
          failed: evidenceCheck.failed,
          failure_reason: evidenceCheck.failure_reason,
        };
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
        console.warn(`[FinOps] [${ctx.runId}] Batch ${batchId} attempt ${attempt} failed:`, error);
        serverLog(ctx.runId, 'warn', 'batch_attempt_failed', {
          batch: batchId,
          attempt,
          error: error?.message || String(error),
        });
      }
    }
    if (lastError) {
      console.error(`[FinOps] [${ctx.runId}] Batch ${batchId} failed after retry. Marking as failed.`);
      aggregated.failed_batches.push(batchId);
      serverLog(ctx.runId, 'error', 'batch_failed', { batch: batchId });
    }
    completedCount++;
    onProgress(completedCount, totalBatches);
  });

  await Promise.all(auditPromises);
  aggregated.models_used = Array.from(modelsSeen);
  aggregated.targeted_rescan_models_used = Array.from(targetedRescanModelsSeen);
  aggregated.evidence_check_models_used = Array.from(evidenceModelsSeen);
  aggregated.evidence_adjudication_models_used = Array.from(evidenceAdjudicationModelsSeen);
  aggregated.evidence_check = mergeEvidenceCheckResults(evidenceResults.sort((a, b) => (a.batch_id || '').localeCompare(b.batch_id || '')));
  return aggregated;
};
