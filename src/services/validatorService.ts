
import { Phase1AuditLogs, AuditItem, Phase2Validation, ValidationResult } from '../types';
import { FINOPS_TACTICS_LOCAL, FINOPS_VALIDATION_RULES } from '../knowledge_base';

const RULES = FINOPS_VALIDATION_RULES as any;

const ALL_CRITERIA_IDS: string[] = Object.values(RULES.phase1.criteria_ids_per_batch).flat() as string[];

export const validatePhase1Output = (rawData: any): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rawData?.phase_1_audit_logs) {
    errors.push('Missing phase_1_audit_logs root key');
    return { valid: false, errors, warnings };
  }

  const logs = rawData.phase_1_audit_logs;
  const streams = RULES.phase1.required_streams as Array<'maturity' | 'antipattern'>;
  const scoreMin = RULES.phase1.score_range.min as number;
  const scoreMax = RULES.phase1.score_range.max as number;
  const evidenceMinLen = RULES.phase1.evidence_min_length_when_scored as number;
  const silenceKeywords = RULES.phase1.silence_keywords as string[];
  const silenceMaxLenBeforeWarn = RULES.phase1.silence_evidence_max_length_before_warning as number;

  for (const stream of streams) {
    if (!logs[stream]) {
      errors.push(`Missing stream: ${stream}`);
      continue;
    }

    const presentIds = new Set(Object.keys(logs[stream]));
    const missingIds = ALL_CRITERIA_IDS.filter(id => !presentIds.has(id));

    if (missingIds.length > 0) {
      errors.push(`${stream}: Missing criteria IDs: ${missingIds.join(', ')}`);
    }

    const duplicateCheck = Object.keys(logs[stream]);
    if (new Set(duplicateCheck).size !== duplicateCheck.length) {
      errors.push(`${stream}: Duplicate criteria IDs detected`);
    }

    for (const [id, item] of Object.entries(logs[stream])) {
      const auditItem = item as any;

      if (typeof auditItem?.count !== 'number' || auditItem.count < scoreMin || auditItem.count > scoreMax || !Number.isInteger(auditItem.count)) {
        errors.push(`${stream}.${id}: Invalid score ${auditItem?.count} (must be integer ${scoreMin}-${scoreMax})`);
      }

      if (auditItem?.count > 0) {
        const evidence = auditItem?.evidence || '';
        const quotes = auditItem?.evidence_quotes || [];
        if (evidence.length < evidenceMinLen && quotes.length === 0) {
          warnings.push(`${stream}.${id}: Score ${auditItem.count} but insufficient evidence`);
        }
      }

      if (auditItem?.count === 0) {
        const evidence = (auditItem?.evidence || '').toLowerCase();
        if (!silenceKeywords.some(kw => evidence.includes(kw)) && evidence.length > silenceMaxLenBeforeWarn) {
          warnings.push(`${stream}.${id}: Score 0 but evidence does not indicate silence`);
        }
      }

      if (!auditItem?.reasoning || typeof auditItem.reasoning !== 'string') {
        warnings.push(`${stream}.${id}: Missing reasoning field`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    repaired: false
  };
};

export const validatePhase3Grounding = (strategyData: any, phase2: Phase2Validation): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!strategyData?.phase_3_strategy) {
    errors.push('Missing phase_3_strategy root key');
    return { valid: false, errors, warnings };
  }

  const strategy = strategyData.phase_3_strategy;
  const summaryMinLen = RULES.phase3.executive_summary_min_length as number;
  const weaselWords = RULES.phase3.weasel_words as string[];
  const tacticIdPattern = new RegExp(RULES.phase3.tactic_id_pattern as string, 'g');
  const requireTacticCitations = RULES.phase3.require_tactic_citations_when_actions_exist as boolean;

  const summaries: Array<{ key: string; text: string }> = [];
  if (strategy.executive_summaries && typeof strategy.executive_summaries === 'object') {
    for (const [key, text] of Object.entries(strategy.executive_summaries)) {
      if (typeof text === 'string') summaries.push({ key, text });
    }
  } else if (typeof strategy.executive_summary === 'string') {
    summaries.push({ key: 'executive_summary', text: strategy.executive_summary });
  }

  if (summaries.length === 0) {
    errors.push('Executive summary missing');
  }

  for (const { key, text } of summaries) {
    if (!text || text.length < summaryMinLen) {
      errors.push(`Executive summary [${key}] missing or too short (min ${summaryMinLen} chars)`);
    }
  }

  if (!strategy.remediation_roadmap || !Array.isArray(strategy.remediation_roadmap) || strategy.remediation_roadmap.length === 0) {
    errors.push('Remediation roadmap missing or empty');
  }

  const allActions: string[] = [];
  if (strategy.remediation_roadmap && Array.isArray(strategy.remediation_roadmap)) {
    for (const phase of strategy.remediation_roadmap) {
      if (phase.actions && Array.isArray(phase.actions)) {
        allActions.push(...phase.actions);
      }
    }
  }

  for (const action of allActions) {
    const lower = action.toLowerCase();
    for (const weasel of weaselWords) {
      if (lower.includes(weasel)) {
        warnings.push(`Weasel word "${weasel}" found in action: "${action.substring(0, 60)}..."`);
      }
    }
  }

  const referencedTacticIds = new Set<string>();
  const roadmapText = (strategy.remediation_roadmap || [])
    .flatMap((p: any) => p.actions || [])
    .join('\n');
  const matches = roadmapText.match(tacticIdPattern);
  if (matches) {
    matches.forEach((id: string) => referencedTacticIds.add(id));
  }

  const validTacticIds = new Set(FINOPS_TACTICS_LOCAL.map(t => t.id));
  for (const refId of referencedTacticIds) {
    if (!validTacticIds.has(refId)) {
      errors.push(`Strategy cites unknown tactic ID "${refId}". Not present in tactics database.`);
    }
  }

  if (requireTacticCitations && referencedTacticIds.size === 0 && allActions.length > 0) {
    errors.push(`Strategy contains ${allActions.length} actions but cites zero tactic IDs. Phase 3 prompt requires inline tactic citations on every tactic-bearing action.`);
  }

  const percentPattern = /(\d+)%/g;
  for (const { key, text } of summaries) {
    const percentMatches = text.match(percentPattern);
    if (!percentMatches) continue;
    for (const pctStr of percentMatches) {
      const pct = parseInt(pctStr);
      if (isNaN(pct)) continue;
      const metricsValues = Object.values(phase2.metrics) as number[];
      const roundedMetrics = metricsValues.map(v => Math.round(v));
      if (!roundedMetrics.includes(pct) && pct !== 100 && pct !== 0) {
        warnings.push(`Percentage ${pctStr} in summary [${key}] may not match Phase 2 metrics`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
};
