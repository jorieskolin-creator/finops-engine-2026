
import { generateBatchSystemInstruction, generateBatchUserPrompt } from './prompts';
import { BATCH_DEFINITIONS } from './knowledge_base';
import { MODEL_PHASE1, GeminiThinkingConfig } from './models';
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

const callGeminiGenerate = async (
  model: string,
  contents: any[],
  systemInstruction: string,
  thinkingConfig?: GeminiThinkingConfig
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 595000);

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, contents, systemInstruction, thinkingConfig }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Proxy Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

export interface Phase1Result {
  phase_1_audit_logs: {
    maturity: Record<string, any>;
    antipattern: Record<string, any>;
  };
  failed_batches: string[];
}

const runSingleBatch = async (batchId: string, text: string, images: ImageInput[]): Promise<{ maturity?: any; antipattern?: any }> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const systemInstruction = generateBatchSystemInstruction(batchId, definitions.title);
  const userPrompt = generateBatchUserPrompt(batchId, definitions);

  const parts: any[] = [
    { text: userPrompt },
    { text: `\n\n<UNTRUSTED_CONTENT>\n${text}\n</UNTRUSTED_CONTENT>` }
  ];
  if (images.length > 0) {
    parts.push({ text: `\n\nThe following ${images.length} image(s) are part of the source material. Treat their visible content as evidence on equal footing with text. Each image is identified by its source filename and (for PDF-derived images) page number; for those, set evidence_source: "image" and include page_number when citing.` });
    for (const img of images) {
      const label = img.page_number !== undefined
        ? `[Image: ${img.source_name} — page ${img.page_number}]`
        : `[Image: ${img.source_name}]`;
      parts.push({ text: `\n${label}\n` });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  const response = await callGeminiGenerate(
    MODEL_PHASE1.id,
    [{ role: 'user', parts }],
    systemInstruction,
    MODEL_PHASE1.thinkingConfig
  );

  return parseAiResponse(response.text);
};

export const runPhase1Audit = async (text: string, images: ImageInput[], onProgress: (completed: number, total: number) => void): Promise<Phase1Result> => {
  const batches = ['A', 'B', 'C', 'D', 'E'];
  const totalBatches = batches.length;

  const aggregated = {
    phase_1_audit_logs: {
      maturity: {} as Record<string, any>,
      antipattern: {} as Record<string, any>
    },
    failed_batches: [] as string[]
  };

  let completedCount = 0;

  const auditPromises = batches.map(async (batchId) => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const batchResult = await runSingleBatch(batchId, text, images);
        if (batchResult.maturity) Object.assign(aggregated.phase_1_audit_logs.maturity, batchResult.maturity);
        if (batchResult.antipattern) Object.assign(aggregated.phase_1_audit_logs.antipattern, batchResult.antipattern);
        if (!batchResult.maturity && !batchResult.antipattern) {
          throw new Error('Batch returned empty result (no maturity or antipattern keys).');
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[FinOps] Batch ${batchId} attempt ${attempt} failed:`, error);
      }
    }
    if (lastError) {
      console.error(`[FinOps] Batch ${batchId} failed after retry. Marking as failed.`);
      aggregated.failed_batches.push(batchId);
    }
    completedCount++;
    onProgress(completedCount, totalBatches);
  });

  await Promise.all(auditPromises);
  return aggregated;
};
