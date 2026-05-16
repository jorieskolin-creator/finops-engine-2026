
import { generateBatchSystemInstruction, generateBatchUserPrompt, generateTargetedBatchUserPrompt } from './prompts';
import { BATCH_DEFINITIONS } from './knowledge_base';
import { runStage, serverLog, RunContext } from './services/modelRouter';
import { EvidenceCheckItem, EvidenceCheckResult, ImageInput } from './types';
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

export interface Phase1Result {
  phase_1_audit_logs: {
    maturity: Record<string, any>;
    antipattern: Record<string, any>;
  };
  evidence_check: EvidenceCheckResult;
  failed_batches: string[];
  models_used: string[];
  evidence_check_models_used: string[];
}

const runSingleBatch = async (
  batchId: string,
  text: string,
  images: ImageInput[],
  ctx: RunContext,
  userPromptOverride?: string
): Promise<BatchAuditResult & { model_used?: string }> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const systemInstruction = generateBatchSystemInstruction(batchId, definitions.title);
  const userPrompt = userPromptOverride || generateBatchUserPrompt(batchId, definitions);

  const userText = `${userPrompt}\n\n<UNTRUSTED_CONTENT>\n${text}\n</UNTRUSTED_CONTENT>`;

  const response = await runStage('forensic_audit', {
    userText,
    systemInstruction,
    images,
  }, ctx);

  const parsed = parseAiResponse(response.text);
  return { ...parsed, model_used: response.modelUsed.id };
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
  return runSingleBatch(batchId, text, images, ctx, prompt);
};

export const runPhase1Audit = async (
  text: string,
  images: ImageInput[],
  onProgress: (completed: number, total: number) => void,
  ctx: RunContext
): Promise<Phase1Result> => {
  const batches = ['A', 'B', 'C', 'D', 'E'];
  const totalBatches = batches.length;

  const aggregated: Phase1Result = {
    phase_1_audit_logs: { maturity: {}, antipattern: {} },
    evidence_check: mergeEvidenceCheckResults([]),
    failed_batches: [],
    models_used: [],
    evidence_check_models_used: [],
  };

  let completedCount = 0;
  const modelsSeen = new Set<string>();
  const evidenceModelsSeen = new Set<string>();
  const evidenceResults: EvidenceCheckResult[] = [];

  const auditPromises = batches.map(async (batchId) => {
    const batchStarted = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let batchResult = await runSingleBatch(batchId, text, images, ctx);
        if (!batchResult.maturity && !batchResult.antipattern) {
          throw new Error('Batch returned empty result (no maturity or antipattern keys).');
        }
        if (batchResult.model_used) modelsSeen.add(batchResult.model_used);

        let evidenceCheck = await runEvidenceCheck(batchId, batchResult, text, images, ctx);
        if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
        const needsRescan = evidenceItemsNeedingRescan(evidenceCheck);
        const rescannedKeys = new Set<string>();
        const preRescanCounts = new Map<string, number>();

        if (!evidenceCheck.failed && needsRescan.length > 0) {
          serverLog(ctx.runId, 'warn', 'evidence_check_targeted_rescan', {
            batch: batchId,
            criteria: needsRescan.map(i => `${i.stream}.${i.id}`).join(','),
          });
          const rescanResult = await runTargetedRescan(batchId, text, images, ctx, needsRescan);
          if (rescanResult.model_used) modelsSeen.add(rescanResult.model_used);
          batchResult = mergeBatchResult(batchResult, rescanResult) as BatchAuditResult & { model_used?: string };
          needsRescan.forEach(i => {
            const key = `${i.stream}.${i.id}`;
            rescannedKeys.add(key);
            preRescanCounts.set(key, i.original_count);
          });

          evidenceCheck = await runEvidenceCheck(batchId, batchResult, text, images, ctx);
          if (evidenceCheck.model_used) evidenceModelsSeen.add(evidenceCheck.model_used);
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
  aggregated.evidence_check_models_used = Array.from(evidenceModelsSeen);
  aggregated.evidence_check = mergeEvidenceCheckResults(evidenceResults);
  return aggregated;
};
