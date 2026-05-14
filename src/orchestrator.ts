
import { generateBatchSystemInstruction, generateBatchUserPrompt } from './prompts';
import { BATCH_DEFINITIONS } from './knowledge_base';
import { runStage, serverLog, RunContext } from './services/modelRouter';
import { ImageInput } from './types';

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
  failed_batches: string[];
  models_used: string[];
}

const runSingleBatch = async (batchId: string, text: string, images: ImageInput[], ctx: RunContext): Promise<{ maturity?: any; antipattern?: any; model_used?: string }> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const systemInstruction = generateBatchSystemInstruction(batchId, definitions.title);
  const userPrompt = generateBatchUserPrompt(batchId, definitions);

  const userText = `${userPrompt}\n\n<UNTRUSTED_CONTENT>\n${text}\n</UNTRUSTED_CONTENT>`;

  const response = await runStage('forensic_audit', {
    userText,
    systemInstruction,
    images,
  }, ctx);

  const parsed = parseAiResponse(response.text);
  return { ...parsed, model_used: response.modelUsed.id };
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
    failed_batches: [],
    models_used: [],
  };

  let completedCount = 0;
  const modelsSeen = new Set<string>();

  const auditPromises = batches.map(async (batchId) => {
    const batchStarted = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const batchResult = await runSingleBatch(batchId, text, images, ctx);
        if (batchResult.maturity) Object.assign(aggregated.phase_1_audit_logs.maturity, batchResult.maturity);
        if (batchResult.antipattern) Object.assign(aggregated.phase_1_audit_logs.antipattern, batchResult.antipattern);
        if (!batchResult.maturity && !batchResult.antipattern) {
          throw new Error('Batch returned empty result (no maturity or antipattern keys).');
        }
        if (batchResult.model_used) modelsSeen.add(batchResult.model_used);
        serverLog(ctx.runId, 'info', 'batch_complete', {
          batch: batchId,
          attempt,
          model: batchResult.model_used,
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
  return aggregated;
};
