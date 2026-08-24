import { BATCH_DEFINITIONS, BATCH_IDS, knowledgeBaseService } from '../knowledge_base';
import {
  AuditItem,
  EvidenceCheckAdjustment,
  EvidenceCheckItem,
  EvidenceCheckResult,
  EvidenceCheckStatus,
  ImageInput,
  AntiPatternAbsenceStatus,
  RoutedSourcePacket,
  SourceRegistry,
  DerivedAnalyticalEvidence,
  CriterionQuestionResult,
} from '../types';
import { runStage, RunContext, serverLog } from './modelRouter';
import { isEvidenceQuoteBoundToChunk, isEvidenceQuoteBoundToDerivedEvidence, isValidEvidenceVerifierItem, verifyTextEvidenceSupport } from './evidenceSupport';
import {
  antiPatternStatusDescription,
  normalizeAntiPatternAbsenceStatus,
  resolveAntiPatternAbsenceStatus
} from './antiPatternSemantics';

type Stream = 'maturity' | 'antipattern';

export interface BatchAuditResult {
  maturity?: Record<string, any>;
  antipattern?: Record<string, any>;
}

const STREAMS: Stream[] = ['maturity', 'antipattern'];
const STATUSES: EvidenceCheckStatus[] = ['supported', 'weak', 'unsupported', 'missing'];

const evidenceCheckFailureCode = (error: any): string => {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) return error.code;
  if (String(error?.message || '').includes('All models exhausted')) return 'MODELS_EXHAUSTED';
  return 'EVIDENCE_CHECK_FAILED';
};

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

const antiPatternReasoningLabel = (status?: AntiPatternAbsenceStatus): string => {
  if (status === 'confirmed_present') return 'Finding';
  if (status === 'partially_present') return 'Partial finding';
  if (status === 'tested_absent') return 'Tested absent';
  return 'Not assessed';
};

const buildEvidenceCheckedReasoning = (input: {
  stream: Stream;
  status: EvidenceCheckStatus;
  originalCount: number;
  verifiedCount: number;
  reason: string;
  rescanAttempted: boolean;
  antipatternAbsenceStatus?: AntiPatternAbsenceStatus;
  coverageReason?: string;
}): string => {
  const prefix = input.stream === 'antipattern'
    ? `Final anti-pattern assessment: ${antiPatternReasoningLabel(input.antipatternAbsenceStatus)}.`
    : `Final maturity assessment: ${statusForScore(input.stream, input.verifiedCount)}.`;
  const scoreLine = `Evidence-check resolved the scanner score from ${input.originalCount} to ${input.verifiedCount}${input.rescanAttempted ? ' after a targeted rescan' : ''}.`;
  const verifierLine = `Verifier status: ${input.status}. ${input.reason}`;
  const coverageLine = input.stream === 'antipattern' && input.coverageReason
    ? `Coverage interpretation: ${input.coverageReason}`
    : '';

  return [prefix, scoreLine, verifierLine, coverageLine].filter(Boolean).join(' ');
};

const idsForBatch = (batchId: string): string[] => [1, 2, 3, 4, 5].map(n => `${batchId}${n}`);

const flattenVerifierItems = (parsed: any): any[] => {
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.evidence_check?.items)) return parsed.evidence_check.items;
  return [];
};

const validatedVerifierItems = (
  value: string,
  batch: BatchAuditResult,
  expectedIds: string[],
): Map<string, any> => {
  const byKey = new Map<string, any>();
  const verifierItems = flattenVerifierItems(parseAiResponse(value));
  for (const raw of verifierItems) {
    if (!raw || typeof raw !== 'object') continue;
    const stream = raw.stream === 'antipattern' ? 'antipattern' : raw.stream === 'maturity' ? 'maturity' : null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const scannerCount = stream && expectedIds.includes(id)
      ? clampScore((batch as any)[stream]?.[id]?.count)
      : -1;
    if (stream && expectedIds.includes(id) && isValidEvidenceVerifierItem({
      raw,
      stream,
      scannerCount,
      duplicate: byKey.has(`${stream}.${id}`),
    })) byKey.set(`${stream}.${id}`, raw);
  }
  const expectedTotal = expectedIds.length * STREAMS.length;
  if (verifierItems.length === 0 || byKey.size !== expectedTotal) {
    throw Object.assign(new Error('Evidence verifier output was incomplete.'), {
      code: 'INVALID_VERIFIER_OUTPUT',
      validItems: byKey.size,
      expectedItems: expectedTotal,
    });
  }
  return byKey;
};

const summarizeBatch = (batch: BatchAuditResult): string => JSON.stringify({
  maturity: batch.maturity || {},
  antipattern: batch.antipattern || {}
}, null, 2);

const buildEvidenceCheckPrompt = (
  batchId: string,
  definitions: any,
  batch: BatchAuditResult,
  text: string,
  referenceKbContext: string
): string => `
<role>
You are an independent FinOps evidence verifier. Your job is NOT to rescan the whole document. Your job is to verify whether the scanner's forwarded findings and scores are actually supported by the raw source material.
</role>

<batch_scope>
Batch ${batchId}: ${definitions.title}
</batch_scope>

${referenceKbContext}

<source_material>
${text}
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
- assessment_status must be "assessed" only when criterion-relevant customer evidence is present. Use "not_assessed" for silence or irrelevant material, regardless of packet size.
- An assessed 0/3 is valid when relevant evidence was evaluated but supports none of the three questions. It is not missing evidence and its source-bound quotes must be retained.
- For text evidence, quoted text must be a real substring or clearly faithful excerpt from the source.
- For deterministic derived evidence, require evidence_source="derived", a known derived_evidence_id, the correct source_id and an exact summary line targeted to this criterion. Never require a chunk_id for derived evidence, never recalculate its values, never infer exact percentages or currency from bands, and never treat association_direction as causality or NOT_FOUND coverage as tested absence.
- When the source contains <CHUNK ...> markers, verify against the exact chunk text. Use chunk IDs/source IDs/page markers in your rationale when they clarify support or absence coverage.
- If the packet says coverage is weak or broad-source fallback was used, do not treat missing packet evidence as positive absence. Mark maturity as missing/silent or anti-pattern absence as unknown unless an exact chunk supports the conclusion.
- For image evidence, the description must be something visible in the attached image content.
- The REFERENCE_KNOWLEDGE_BASE is rubric/reference material only. It can clarify what good evidence looks like, false positives, and coverage expectations, but it is never source evidence for this customer.
- Do not invent stronger scores. If unsure, recommend the lower score.
- verified_count must be 0-3 and must not exceed original_count.
- rescan_recommended should be true when status is weak, unsupported, or missing and original_count > 0.
- For anti-pattern items, also return antipattern_absence_status:
  - "confirmed_present": verified_count > 0 and the harmful pattern is evidenced.
  - "partially_present": verified_count is 1-2 or the harmful pattern signal is weak/partial.
  - "tested_absent": verified_count is 0, original_count is 0, no weak/partial harmful signal exists, AND the source has relevant coverage that would reasonably reveal the anti-pattern if present.
  - "unknown_absent": verified_count is 0 BUT the source is silent, irrelevant, or too weak to prove absence.
- Never label an anti-pattern "tested_absent" when status is "weak", original_count is above 0, or the rationale/coverage_reason says there is partial harmful-pattern evidence. Use "partially_present" for weak but real harmful signals, or "unknown_absent" when the signal is too weak to count.
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
      "assessment_status": "assessed | not_assessed",
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

const needsAntiPatternAdjudication = (item: EvidenceCheckItem): boolean => {
  return item.stream === 'antipattern'
    && item.original_count > 0
    && item.verified_count === 0
    && (item.status === 'weak' || item.status === 'unsupported' || item.status === 'missing')
    && item.antipattern_absence_status !== 'partially_present';
};

const buildAntiPatternAdjudicationPrompt = (
  batchId: string,
  text: string,
  items: EvidenceCheckItem[],
  batch: BatchAuditResult
): string => `
<role>
You are a senior FinOps evidence adjudicator. A first evidence-check found disputed anti-pattern signals. Your job is only to decide whether each disputed item is a weak/partial harmful anti-pattern finding or not assessable from source coverage.
</role>

<rules>
- The REFERENCE or Knowledge Base is not customer source evidence.
- Do not upgrade maturity or invent new findings.
- For each item choose exactly one status:
  - "partially_present": the source contains weak, partial, indirect, or low-confidence evidence of the harmful anti-pattern.
  - "unknown_absent": the scanner signal is not reliable enough and source coverage is too weak, silent, irrelevant, or contradictory to support either a finding or tested absence.
- Do not return "tested_absent" for these disputed items because the scanner already found a harmful signal and the verifier could not support a clean absence.
- Prefer "unknown_absent" when the source does not actually discuss the anti-pattern topic.
- Prefer "partially_present" when the source discusses the topic and shows a weak version of the harmful pattern.
</rules>

<source_material>
${text}
</source_material>

<scanner_output>
${summarizeBatch(batch)}
</scanner_output>

<disputed_items>
${items.map(i => `- antipattern.${i.id}: scanner=${i.original_count}, verifier=${i.verified_count}, evidence_status=${i.status}, current_semantics=${i.antipattern_absence_status || 'unknown'}, rationale=${i.rationale}, coverage=${i.coverage_reason || ''}`).join('\n')}
</disputed_items>

<output_format>
Return STRICT JSON:
{
  "items": [
    {
      "id": "${batchId}1",
      "antipattern_absence_status": "partially_present | unknown_absent",
      "rationale": "Short source-grounded reason for the adjudication.",
      "coverage_reason": "Short source coverage interpretation."
    }
  ]
}
</output_format>
`;

const applyAntiPatternAdjudication = async (
  batchId: string,
  batch: BatchAuditResult,
  text: string,
  images: ImageInput[],
  ctx: RunContext,
  items: EvidenceCheckItem[]
): Promise<{ items: EvidenceCheckItem[]; model_used?: string; failed?: boolean; failure_reason?: string }> => {
  const candidates = items.filter(needsAntiPatternAdjudication);
  if (candidates.length === 0) return { items };

  try {
    const resp = await runStage('evidence_adjudication', {
      userText: buildAntiPatternAdjudicationPrompt(batchId, text, candidates, batch),
      images,
    }, ctx);
    const parsed = parseAiResponse(resp.text);
    const decisions = new Map<string, any>();
    for (const raw of flattenVerifierItems(parsed)) {
      if (
        raw && typeof raw === 'object'
        && typeof raw.id === 'string'
        && candidates.some(item => item.id === raw.id)
        && (raw.antipattern_absence_status === 'partially_present' || raw.antipattern_absence_status === 'unknown_absent')
        && typeof raw.rationale === 'string'
        && raw.rationale.trim().length > 0
        && typeof raw.coverage_reason === 'string'
        && raw.coverage_reason.trim().length > 0
      ) {
        decisions.set(raw.id, raw);
      }
    }
    const unresolved = candidates.filter(item => !decisions.has(item.id));
    const next = items.map(item => {
      if (!needsAntiPatternAdjudication(item)) return item;
      const decision = decisions.get(item.id);
      if (!decision) {
        return {
          ...item,
          status: 'missing' as const,
          verified_count: 0,
          rationale: 'Required anti-pattern adjudication did not return a valid decision for this criterion.',
          antipattern_absence_status: 'unknown_absent' as const,
          coverage_reason: 'Adjudication was unresolved, so neither presence nor tested absence can be claimed.',
          adjudication_unresolved: true,
          rescan_recommended: false,
          quote_supported: false,
        };
      }
      const status = normalizeAntiPatternAbsenceStatus(decision?.antipattern_absence_status);
      if (status !== 'partially_present' && status !== 'unknown_absent') return item;
      const rationale = typeof decision?.rationale === 'string' && decision.rationale.trim().length > 0
        ? `Adjudication: ${decision.rationale.trim()}`
        : item.rationale;
      const coverageReason = typeof decision?.coverage_reason === 'string' && decision.coverage_reason.trim().length > 0
        ? decision.coverage_reason.trim()
        : item.coverage_reason;
      return {
        ...item,
        status: status === 'partially_present' ? 'weak' : item.status,
        verified_count: status === 'partially_present' ? Math.max(1, item.verified_count) : 0,
        rationale,
        antipattern_absence_status: status,
        coverage_reason: coverageReason,
        rescan_recommended: item.rescan_recommended || (status === 'partially_present' && item.original_count > Math.max(1, item.verified_count)),
      };
    });
    await serverLog(ctx.runId, 'info', 'evidence_adjudication_used', {
      batch: batchId,
      model: resp.modelUsed.id,
      criteria_count: candidates.length,
      accepted_count: decisions.size,
      unresolved_count: unresolved.length,
    });
    return {
      items: next,
      model_used: resp.modelUsed.id,
      failed: unresolved.length > 0,
      failure_reason: unresolved.length > 0
        ? `Anti-pattern adjudication returned ${decisions.size}/${candidates.length} required decisions.`
        : undefined,
    };
  } catch (error: any) {
    await serverLog(ctx.runId, 'warn', 'evidence_adjudication_failed', {
      batch: batchId,
      criteria_count: candidates.length,
      error_code: 'ADJUDICATION_FAILED',
    });
    const unresolved = new Set(candidates.map(item => item.id));
    return {
      items: items.map(item => unresolved.has(item.id)
        ? {
            ...item,
            status: 'missing' as const,
            verified_count: 0,
            rationale: 'Required anti-pattern adjudication did not complete for this criterion.',
            antipattern_absence_status: 'unknown_absent' as const,
            coverage_reason: 'Adjudication was unresolved, so neither presence nor tested absence can be claimed.',
            adjudication_unresolved: true,
            rescan_recommended: false,
            quote_supported: false,
          }
        : item),
      failed: true,
      failure_reason: error?.message || String(error),
    };
  }
};

export const buildUnavailableEvidenceCheck = (
  batchId: string,
  batch: BatchAuditResult,
  failureReason: string,
): EvidenceCheckResult => {
  const expectedIds = idsForBatch(batchId);
  const items: EvidenceCheckItem[] = STREAMS.flatMap(stream => expectedIds.map(id => {
    const original = clampScore((batch as any)[stream]?.[id]?.count);
    return {
      stream,
      id,
      status: 'missing' as const,
      original_count: original,
      verified_count: 0,
      rationale: 'Evidence verification was unavailable; the scanner candidate is retained for traceability but excluded from validated scoring.',
      rescan_recommended: false,
      quote_supported: false,
      verification_unresolved: true,
      ...(stream === 'antipattern' ? {
        antipattern_absence_status: 'unknown_absent' as const,
        coverage_reason: 'Verification was unavailable, so neither anti-pattern presence nor tested absence can be claimed.',
      } : {}),
    };
  }));
  return {
    ...summarizeEvidenceCheck(batchId, items, []),
    failed: true,
    failure_reason: failureReason,
  };
};

export const runEvidenceCheck = async (
  batchId: string,
  batch: BatchAuditResult,
  text: string,
  images: ImageInput[],
  ctx: RunContext
): Promise<EvidenceCheckResult> => {
  const definitions = BATCH_DEFINITIONS[batchId];
  const expectedIds = idsForBatch(batchId);
  let lastError: any;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
    const referenceKbContext = await knowledgeBaseService.fetchReferenceKnowledgeBaseContext({
      batchId,
      maxDocChars: 1100,
      label: 'evidence_check',
    });
    const resp = await runStage('evidence_check', {
      userText: buildEvidenceCheckPrompt(batchId, definitions, batch, text, referenceKbContext),
      images,
      validateOutput: value => { validatedVerifierItems(value, batch, expectedIds); },
    }, ctx);
    const byKey = validatedVerifierItems(resp.text, batch, expectedIds);

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
        let verified_count = Math.min(original, rawVerified, locallyCapped);
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
            original,
            status,
            raw?.antipattern_absence_status,
            scannerItem || {},
            rationale,
            typeof raw?.coverage_reason === 'string' ? raw.coverage_reason : undefined
          )
          : undefined;
        if (
          stream === 'antipattern' &&
          antipattern_absence_status === 'partially_present' &&
          original > 0 &&
          verified_count === 0
        ) {
          verified_count = 1;
        }
        const coverage_reason = stream === 'antipattern'
          ? (typeof raw?.coverage_reason === 'string'
            ? raw.coverage_reason
            : antiPatternStatusDescription(antipattern_absence_status || 'unknown_absent'))
          : undefined;
        items.push({
          stream,
          id,
          status,
          assessment_status: scannerItem?.assessment_status === 'assessed' && localStatus === 'supported'
            ? 'assessed'
            : 'not_assessed',
          original_count: original,
          verified_count,
          rationale,
          rescan_recommended: Boolean(raw?.rescan_recommended)
            || (original > verified_count)
            || scannerItem?.assessment_status === 'not_assessed',
          quote_supported: localStatus === 'supported'
            ? (typeof raw?.quote_supported === 'boolean' ? raw.quote_supported : status === 'supported')
            : false,
          antipattern_absence_status,
          coverage_reason
        });
      }
    }

    const adjudicated = await applyAntiPatternAdjudication(batchId, batch, text, images, ctx, items);
    return {
      ...summarizeEvidenceCheck(batchId, adjudicated.items, []),
      model_used: resp.modelUsed.id,
      adjudication_model_used: adjudicated.model_used,
      failed: adjudicated.failed,
      failure_reason: adjudicated.failure_reason,
    };
    } catch (error: any) {
      lastError = error;
      if (attempt < 2) {
        await serverLog(ctx.runId, 'warn', 'evidence_check_retry', {
          batch: batchId,
          attempt,
          error_code: evidenceCheckFailureCode(error),
          valid_items: error?.validItems,
          expected_items: error?.expectedItems,
        });
      }
    }
  }
  const failureCode = evidenceCheckFailureCode(lastError);
  await serverLog(ctx.runId, 'warn', 'evidence_check_unavailable', {
    batch: batchId,
    attempts: 2,
    error_code: failureCode,
    valid_items: lastError?.validItems,
    expected_items: lastError?.expectedItems,
  });
  return buildUnavailableEvidenceCheck(batchId, batch, failureCode);
};

export const evidenceItemsNeedingRescan = (result: EvidenceCheckResult): EvidenceCheckItem[] => {
  return result.items.filter(item =>
    (item.status === 'weak' || item.assessment_status === 'not_assessed') &&
    item.rescan_recommended === true
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
  original: number,
  evidenceStatus: EvidenceCheckStatus | undefined,
  rawStatus: unknown,
  existing: Partial<AuditItem>,
  rationale: string,
  coverageReason?: string
): AntiPatternAbsenceStatus => {
  return resolveAntiPatternAbsenceStatus({
    verifiedCount: verified,
    originalCount: original,
    explicitStatus: rawStatus,
    evidenceStatus,
    existing,
    rationale,
    coverageReason
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
    const key = `${item.stream}.${item.id}`;
    const reason = item.rationale || 'Evidence verifier adjusted this score.';
    if (item.verification_unresolved) {
      streamBucket[item.id] = {
        ...existing,
        evidence_check_status: item.status,
        original_count: item.original_count,
        verified_count: null,
        adjustment_reason: reason,
        rescan_attempted: false,
        verification_unresolved: true,
        reasoning: `Evidence verification was unavailable. The scanner candidate score (${item.original_count}) is retained for traceability but excluded from validated scoring.`,
      };
      adjustments.push({
        stream: item.stream,
        id: item.id,
        original_count: item.original_count,
        verified_count: 0,
        status: item.status,
        reason,
        rescan_attempted: false,
        verification_unresolved: true,
      });
      continue;
    }
    const verified = Math.min(item.original_count, item.verified_count);
    const antipatternAbsenceStatus = item.stream === 'antipattern'
      ? antiPatternStatusForItem(
          verified,
          item.original_count,
          item.status,
          item.antipattern_absence_status,
          existing,
          reason,
          item.coverage_reason
        )
      : undefined;
    const finalCount = item.stream === 'antipattern' && antipatternAbsenceStatus === 'partially_present' && item.original_count > 0 && verified === 0
      ? 1
      : verified;
    const downgraded = finalCount < item.original_count;
    const coverageReason = item.coverage_reason || existing.coverage_reason || (antipatternAbsenceStatus ? antiPatternStatusDescription(antipatternAbsenceStatus) : undefined);
    const shouldRewriteReasoning = item.stream === 'antipattern'
      || downgraded
      || item.status !== 'supported'
      || rescannedKeys.has(key);
    let remainingSupported = finalCount;
    const finalQuestionResults = item.assessment_status === 'assessed'
      ? (existing.question_results || []).map((result: CriterionQuestionResult) => {
          if (result !== 'supported') return result;
          if (remainingSupported > 0) {
            remainingSupported--;
            return result;
          }
          return 'unknown' as const;
        })
      : ['unknown', 'unknown', 'unknown'] as const;

    streamBucket[item.id] = {
      ...existing,
      count: finalCount,
      status: statusForScore(item.stream, finalCount),
      assessment_status: item.assessment_status || existing.assessment_status || 'not_assessed',
      question_results: finalQuestionResults,
      evidence: downgraded && finalCount === 0
        ? `Evidence-check downgraded this finding: ${reason}`
        : existing.evidence,
      evidence_quotes: item.assessment_status === 'assessed' || antipatternAbsenceStatus === 'tested_absent'
        ? (existing.evidence_quotes || [])
        : [],
      is_silent: item.stream === 'antipattern'
        ? antipatternAbsenceStatus === 'unknown_absent'
        : item.assessment_status !== 'assessed',
      evidence_check_status: item.status,
      original_count: item.original_count,
      verified_count: finalCount,
      adjustment_reason: reason,
      rescan_attempted: rescannedKeys.has(key),
      verification_unresolved: false,
      antipattern_absence_status: antipatternAbsenceStatus,
      coverage_reason: coverageReason,
      reasoning: shouldRewriteReasoning
        ? buildEvidenceCheckedReasoning({
            stream: item.stream,
            status: item.status,
            originalCount: item.original_count,
            verifiedCount: finalCount,
            reason,
            rescanAttempted: rescannedKeys.has(key),
            antipatternAbsenceStatus,
            coverageReason
          })
        : existing.reasoning
    };

    if (downgraded || item.status !== 'supported' || rescannedKeys.has(key)) {
      adjustments.push({
        stream: item.stream,
        id: item.id,
        original_count: item.original_count,
        verified_count: finalCount,
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
    downgraded_count: adjustments.filter(a => !a.verification_unresolved && a.verified_count < a.original_count).length,
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
    adjudication_model_used: Array.from(new Set(results.map(r => r.adjudication_model_used).filter(Boolean))).join(',') || undefined,
    failure_reason: results.filter(r => r.failure_reason).map(r => `${r.batch_id}: ${r.failure_reason}`).join(' | ') || undefined
  };
};

interface ProvenancePhase1Result {
  phase_1_audit_logs: {
    maturity: Record<string, any>;
    antipattern: Record<string, any>;
  };
  evidence_check: EvidenceCheckResult;
}

export const reconcileEvidenceProvenance = <T extends ProvenancePhase1Result>(
  phase1: T,
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
  derivedEvidence: DerivedAnalyticalEvidence[] = [],
): { result: T; adjustedCriteria: string[]; removedQuoteCount: number } => {
  const logs = {
    maturity: { ...phase1.phase_1_audit_logs.maturity },
    antipattern: { ...phase1.phase_1_audit_logs.antipattern },
  };
  const chunks = new Map(registry.chunks.map(chunk => [chunk.chunk_id, chunk]));
  const derivedById = new Map(derivedEvidence.map(item => [item.evidence_id, item]));
  const evidenceItems = phase1.evidence_check.items.map(item => ({ ...item }));
  const evidenceItemsByKey = new Map(evidenceItems.map(item => [`${item.stream}.${item.id}`, item]));
  const adjustmentsByKey = new Map(phase1.evidence_check.adjustments.map(item => [`${item.stream}.${item.id}`, { ...item }]));
  const adjustedCriteria = new Set<string>();
  let removedQuoteCount = 0;

  for (const domain of BATCH_IDS) {
    const manifest = new Map((packets[domain]?.manifest || []).map(item => [item.chunk_id, item]));
    for (const stream of STREAMS) {
      for (let index = 1; index <= 5; index++) {
        const id = `${domain}${index}`;
        const existing = logs[stream][id];
        if (!existing || !Array.isArray(existing.evidence_quotes)) continue;
        const validQuotes = existing.evidence_quotes.filter((quote: any) => {
          if (quote?.evidence_source === 'derived') {
            return isEvidenceQuoteBoundToDerivedEvidence(quote, derivedById.get(quote.derived_evidence_id), stream, id);
          }
          const located = typeof quote?.chunk_id === 'string' ? manifest.get(quote.chunk_id) : undefined;
          return isEvidenceQuoteBoundToChunk(quote || {}, located, located ? chunks.get(located.chunk_id) : undefined);
        });
        const count = Number.isInteger(existing.count) ? Math.max(0, Math.min(3, existing.count)) : 0;
        if (validQuotes.length === existing.evidence_quotes.length && (count === 0 || validQuotes.length > 0)) continue;

        removedQuoteCount += existing.evidence_quotes.length - validQuotes.length;
        adjustedCriteria.add(id);
        logs[stream][id] = { ...existing, evidence_quotes: validQuotes };
        if (existing.verification_unresolved) continue;
        if (validQuotes.length > 0) continue;

        if (count === 0) {
          logs[stream][id] = {
            ...logs[stream][id],
            evidence_check_status: 'unsupported',
            assessment_status: 'not_assessed',
            question_results: ['unknown', 'unknown', 'unknown'],
            is_silent: true,
            ...(stream === 'antipattern' ? {
              antipattern_absence_status: 'unknown_absent',
              coverage_reason: 'No source-bound criterion evidence remained, so the anti-pattern was not assessed.',
            } : {}),
          };
          const key = `${stream}.${id}`;
          const verdict = evidenceItemsByKey.get(key);
          if (verdict) {
            Object.assign(verdict, {
              status: 'unsupported',
              assessment_status: 'not_assessed',
              verified_count: 0,
              rationale: 'Deterministic provenance validation removed the assessment because no source-bound criterion evidence remained.',
              quote_supported: false,
              rescan_recommended: false,
              ...(stream === 'antipattern' ? {
                antipattern_absence_status: 'unknown_absent',
                coverage_reason: 'No source-bound criterion evidence remained, so the anti-pattern was not assessed.',
              } : {}),
            });
          }
          continue;
        }

        const key = `${stream}.${id}`;
        const verdict = evidenceItemsByKey.get(key);
        const originalCount = Math.max(count, verdict?.original_count || 0, existing.original_count || 0);
        const reason = 'Deterministic provenance validation removed the score because no quote was bound to its cited source chunk.';
        logs[stream][id] = {
          ...logs[stream][id],
          count: 0,
          status: stream === 'antipattern' ? 'OK' : 'NOK',
          evidence: reason,
          evidence_quotes: [],
          assessment_status: 'not_assessed',
          question_results: ['unknown', 'unknown', 'unknown'],
          is_silent: true,
          evidence_check_status: 'unsupported',
          original_count: originalCount,
          verified_count: 0,
          adjustment_reason: reason,
          ...(stream === 'antipattern' ? {
            antipattern_absence_status: 'unknown_absent',
            coverage_reason: 'The prior anti-pattern signal lacked source-bound evidence, so absence is not established.',
          } : {}),
        };
        if (verdict) {
          Object.assign(verdict, {
            status: 'unsupported',
            verified_count: 0,
            rationale: reason,
            quote_supported: false,
            rescan_recommended: false,
            ...(stream === 'antipattern' ? {
              antipattern_absence_status: 'unknown_absent',
              coverage_reason: 'The prior anti-pattern signal lacked source-bound evidence, so absence is not established.',
            } : {}),
          });
        }
        const priorAdjustment = adjustmentsByKey.get(key);
        adjustmentsByKey.set(key, {
          stream,
          id,
          original_count: originalCount,
          verified_count: 0,
          status: 'unsupported',
          reason,
          rescan_attempted: priorAdjustment?.rescan_attempted || existing.rescan_attempted === true,
        });
      }
    }
  }

  const summarized = summarizeEvidenceCheck(undefined, evidenceItems, [...adjustmentsByKey.values()]);
  return {
    result: {
      ...phase1,
      phase_1_audit_logs: logs,
      evidence_check: {
        ...phase1.evidence_check,
        ...summarized,
        failed: phase1.evidence_check.failed,
        failure_reason: phase1.evidence_check.failure_reason,
        adjudication_model_used: phase1.evidence_check.adjudication_model_used,
      },
    },
    adjustedCriteria: [...adjustedCriteria].sort(),
    removedQuoteCount,
  };
};
