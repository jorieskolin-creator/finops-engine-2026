import { BATCH_DEFINITIONS } from '../knowledge_base';
import {
  AuditItem,
  EvidenceCheckAdjustment,
  EvidenceCheckItem,
  EvidenceCheckResult,
  EvidenceCheckStatus,
  ImageInput,
  AntiPatternAbsenceStatus
} from '../types';
import { runStage, RunContext } from './modelRouter';
import { verifyTextEvidenceSupport } from './evidenceSupport';
import {
  antiPatternStatusDescription,
  inferAntiPatternAbsenceStatus,
  normalizeAntiPatternAbsenceStatus
} from './antiPatternSemantics';

type Stream = 'maturity' | 'antipattern';

export interface BatchAuditResult {
  maturity?: Record<string, any>;
  antipattern?: Record<string, any>;
}

const STREAMS: Stream[] = ['maturity', 'antipattern'];
const STATUSES: EvidenceCheckStatus[] = ['supported', 'weak', 'unsupported', 'missing'];

const parseAiResponse = (text: string): any => {
  if (!text) return {};
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
};

const clampScore = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 3);
};

const statusFor = (raw: unknown): EvidenceCheckStatus => {
  return typeof raw === 'string' && STATUSES.includes(raw as EvidenceCheckStatus)
    ? raw as EvidenceCheckStatus
    : 'missing';
};

const idsForBatch = (batchId: string): string[] => [1, 2, 3, 4, 5].map(n => `${batchId}${n}`);

const flattenVerifierItems = (parsed: any): any[] => {
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.evidence_check?.items)) return parsed.evidence_check.items;
  return [];
};

const summarizeBatch = (batch: BatchAuditResult): string => JSON.stringify({
  maturity: batch.maturity || {},
  antipattern: batch.antipattern || {}
}, null, 2);

const buildEvidenceCheckPrompt = (
  batchId: string,
  definitions: any,
  batch: BatchAuditResult,
  text: string
): string => `
<role>
You are an independent FinOps evidence verifier. Your job is NOT to rescan the whole document. Your job is to verify whether the scanner's forwarded findings and scores are actually supported by the raw source material.
</role>

<batch_scope>
Batch ${batchId}: ${definitions.title}
</batch_scope>

<source_material>
${text.substring(0, 50000)}
</source_material>

<batch_definitions>
=== MATURITY ===
${definitions.maturity}

=== ANTI-PATTERNS ===
${definitions.antipattern}
</batch_definitions>

<scanner_output_to_verify>
${summarizeBatch(batch)}
</scanner_output_to_verify>

<rules>
- Verify each listed criterion independently.
- "supported": the score and quoted evidence are adequately supported by the source.
- "weak": the source has some related evidence, but the score is too strong or the quote is vague.
- "unsupported": the finding/score is not supported by the source.
- "missing": the scanner scored >0 but did not provide usable traceable evidence, or the evidence cannot be located.
- For text evidence, quoted text must be a real substring or clearly faithful excerpt from the source.
- For image evidence, the description must be something visible in the attached image content.
- Do not invent stronger scores. If unsure, recommend the lower score.
- verified_count must be 0-3 and must not exceed original_count.
- rescan_recommended should be true when status is weak, unsupported, or missing and original_count > 0.
- For anti-pattern items, also return antipattern_absence_status:
  - "confirmed_present": verified_count > 0 and the harmful pattern is evidenced.
  - "partially_present": verified_count is 1-2 or the harmful pattern signal is weak/partial.
  - "tested_absent": verified_count is 0 AND the source has relevant coverage that would reasonably reveal the anti-pattern if present.
  - "unknown_absent": verified_count is 0 BUT the source is silent, irrelevant, or too weak to prove absence.
- For anti-pattern "tested_absent" or "unknown_absent", include coverage_reason explaining why absence is meaningful or why it is not assessable.
</rules>

<output_format>
Return STRICT JSON:
{
  "items": [
    {
      "stream": "maturity | antipattern",
      "id": "${batchId}1",
      "status": "supported | weak | unsupported | missing",
      "original_count": 2,
      "verified_count": 1,
      "rationale": "Short explanation of what the raw material does or does not support.",
      "quote_supported": true,
      "antipattern_absence_status": "confirmed_present | partially_present | tested_absent | unknown_absent",
      "coverage_reason": "For anti-patterns only: why absence is verified or not assessable.",
      "rescan_recommended": true
    }
  ]
}
</output_format>
`;

export const runEvidenceCheck = async (
  batchId: string,
  batch: BatchAuditResult,
  text: string,
  images: ImageInput[],
  ctx: RunContext
): Promise<EvidenceCheckResult> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const expectedIds = idsForBatch(batchId);
  const expectedTotal = expectedIds.length * STREAMS.length;

  try {
    const resp = await runStage('evidence_check', {
      userText: buildEvidenceCheckPrompt(batchId, definitions, batch, text),
      images,
    }, ctx);
    const parsed = parseAiResponse(resp.text);
    const byKey = new Map<string, any>();
    for (const raw of flattenVerifierItems(parsed)) {
      if (!raw || typeof raw !== 'object') continue;
      const stream = raw.stream === 'antipattern' ? 'antipattern' : raw.stream === 'maturity' ? 'maturity' : null;
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!stream || !expectedIds.includes(id)) continue;
      byKey.set(`${stream}.${id}`, raw);
    }

    const items: EvidenceCheckItem[] = [];
    for (const stream of STREAMS) {
      for (const id of expectedIds) {
        const original = clampScore((batch as any)[stream]?.[id]?.count);
        const raw = byKey.get(`${stream}.${id}`);
        const scannerItem = (batch as any)[stream]?.[id] as Partial<AuditItem> | undefined;
        const localStatus = verifyTextEvidenceSupport(scannerItem, text);
        let status = original === 0
          ? (raw && statusFor(raw?.status) !== 'missing' ? statusFor(raw?.status) : 'supported')
          : statusFor(raw?.status);
        if (original > 0 && localStatus !== 'supported') {
          status = status === 'supported' || localStatus === 'missing' || localStatus === 'unsupported'
            ? localStatus
            : status;
        }
        const fallbackVerified = localStatus === 'supported'
          ? original
          : localStatus === 'weak'
            ? Math.max(0, original - 1)
            : 0;
        const rawVerified = raw ? clampScore(raw.verified_count) : fallbackVerified;
        const locallyCapped = localStatus === 'missing' || localStatus === 'unsupported'
          ? 0
          : localStatus === 'weak'
            ? Math.max(0, original - 1)
            : original;
        const verified_count = Math.min(original, rawVerified, locallyCapped);
        if (original > verified_count && status === 'supported') {
          status = verified_count === 0 ? 'unsupported' : 'weak';
        }
        const rationale = typeof raw?.rationale === 'string'
          ? raw.rationale
          : original === 0
            ? 'Scanner reported no finding; anti-pattern absence still depends on source coverage.'
            : localStatus === 'supported'
              ? 'Deterministic fallback found scanner evidence in the raw source.'
              : 'Evidence verifier did not return a supported result for this scored finding.';
        const antipattern_absence_status = stream === 'antipattern'
          ? antiPatternStatusForItem(
            verified_count,
            raw?.antipattern_absence_status,
            scannerItem || {},
            typeof raw?.coverage_reason === 'string' ? raw.coverage_reason : rationale
          )
          : undefined;
        const coverage_reason = stream === 'antipattern'
          ? (typeof raw?.coverage_reason === 'string'
            ? raw.coverage_reason
            : antiPatternStatusDescription(antipattern_absence_status || 'unknown_absent'))
          : undefined;
        items.push({
          stream,
          id,
          status,
          original_count: original,
          verified_count,
          rationale,
          rescan_recommended: Boolean(raw?.rescan_recommended) || (original > verified_count),
          quote_supported: localStatus === 'supported'
            ? (typeof raw?.quote_supported === 'boolean' ? raw.quote_supported : status === 'supported')
            : false,
          antipattern_absence_status,
          coverage_reason
        });
      }
    }

    return { ...summarizeEvidenceCheck(batchId, items, []), model_used: resp.modelUsed.id };
  } catch (error: any) {
    return {
      batch_id: batchId,
      total_items: expectedTotal,
      supported_count: 0,
      weak_count: 0,
      unsupported_count: 0,
      missing_count: expectedTotal,
      downgraded_count: 0,
      rescan_count: 0,
      items: [],
      adjustments: [],
      failed: true,
      failure_reason: error?.message || String(error)
    };
  }
};

export const evidenceItemsNeedingRescan = (result: EvidenceCheckResult): EvidenceCheckItem[] => {
  return result.items.filter(item =>
    item.original_count > 0 &&
    item.rescan_recommended &&
    item.verified_count < item.original_count
  );
};

const statusForScore = (stream: Stream, count: number): AuditItem['status'] => {
  if (stream === 'maturity') {
    if (count === 3) return 'OK';
    if (count === 0) return 'NOK';
    return 'Partial';
  }
  if (count === 0) return 'OK';
  if (count === 3) return 'NOK';
  return 'Partial';
};

const antiPatternStatusForItem = (
  verified: number,
  rawStatus: unknown,
  existing: Partial<AuditItem>,
  rationale: string
): AntiPatternAbsenceStatus => {
  const explicit = normalizeAntiPatternAbsenceStatus(rawStatus);
  if (verified >= 3) return 'confirmed_present';
  if (verified > 0) return 'partially_present';
  if (explicit === 'tested_absent' || explicit === 'unknown_absent') return explicit;
  return inferAntiPatternAbsenceStatus({
    ...existing,
    count: verified,
    coverage_reason: existing.coverage_reason || rationale
  });
};

export const applyEvidenceCheckToBatch = (
  batch: BatchAuditResult,
  result: EvidenceCheckResult,
  rescannedKeys: Set<string>
): { batch: BatchAuditResult; adjustments: EvidenceCheckAdjustment[] } => {
  const checked: BatchAuditResult = {
    maturity: { ...(batch.maturity || {}) },
    antipattern: { ...(batch.antipattern || {}) }
  };
  const adjustments: EvidenceCheckAdjustment[] = [];

  for (const item of result.items) {
    const streamBucket = (checked as any)[item.stream] || {};
    const existing = streamBucket[item.id] || {};
    const verified = Math.min(item.original_count, item.verified_count);
    const key = `${item.stream}.${item.id}`;
    const downgraded = verified < item.original_count;
    const reason = item.rationale || 'Evidence verifier adjusted this score.';
    const antipatternAbsenceStatus = item.stream === 'antipattern'
      ? item.antipattern_absence_status || antiPatternStatusForItem(verified, undefined, existing, reason)
      : undefined;

    streamBucket[item.id] = {
      ...existing,
      count: verified,
      status: statusForScore(item.stream, verified),
      evidence: downgraded && verified === 0
        ? `Evidence-check downgraded this finding: ${reason}`
        : existing.evidence,
      evidence_quotes: verified === 0 && antipatternAbsenceStatus !== 'tested_absent'
        ? []
        : (existing.evidence_quotes || []),
      is_silent: item.stream === 'antipattern'
        ? antipatternAbsenceStatus === 'unknown_absent'
        : existing.is_silent,
      evidence_check_status: item.status,
      original_count: item.original_count,
      verified_count: verified,
      adjustment_reason: reason,
      rescan_attempted: rescannedKeys.has(key),
      antipattern_absence_status: antipatternAbsenceStatus,
      coverage_reason: item.coverage_reason || existing.coverage_reason || (antipatternAbsenceStatus ? antiPatternStatusDescription(antipatternAbsenceStatus) : undefined)
    };

    if (downgraded || item.status !== 'supported' || rescannedKeys.has(key)) {
      adjustments.push({
        stream: item.stream,
        id: item.id,
        original_count: item.original_count,
        verified_count: verified,
        status: item.status,
        reason,
        rescan_attempted: rescannedKeys.has(key)
      });
    }
  }

  return { batch: checked, adjustments };
};

export const summarizeEvidenceCheck = (
  batchId: string | undefined,
  items: EvidenceCheckItem[],
  adjustments: EvidenceCheckAdjustment[]
): EvidenceCheckResult => {
  const countBy = (status: EvidenceCheckStatus) => items.filter(i => i.status === status).length;
  return {
    batch_id: batchId,
    total_items: items.length,
    supported_count: countBy('supported'),
    weak_count: countBy('weak'),
    unsupported_count: countBy('unsupported'),
    missing_count: countBy('missing'),
    downgraded_count: adjustments.filter(a => a.verified_count < a.original_count).length,
    rescan_count: adjustments.filter(a => a.rescan_attempted).length,
    items,
    adjustments
  };
};

export const mergeEvidenceCheckResults = (results: EvidenceCheckResult[]): EvidenceCheckResult => {
  const items = results.flatMap(r => r.items);
  const adjustments = results.flatMap(r => r.adjustments);
  const merged = summarizeEvidenceCheck(undefined, items, adjustments);
  return {
    ...merged,
    failed: results.some(r => r.failed),
    failure_reason: results.filter(r => r.failure_reason).map(r => `${r.batch_id}: ${r.failure_reason}`).join(' | ') || undefined
  };
};
