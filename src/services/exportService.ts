
import { AuditItem, DiagnosticResult, QualityGateResult } from '../types';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { METRIC_DESCRIPTIONS } from '../constants';
import { SVG_CSS, svgGaugeCard, svgRadar, svgScatter } from './svgChartService';
import { isInsufficientEvidenceReport, renderInlineMarkdownHtml, renderMarkdownSummaryHtml, strengthsSectionTitle } from './reportTextService';
import { antiPatternStatusLabel, inferAntiPatternAbsenceStatus } from './antiPatternSemantics';
import { displayQualityGateDiagnostic, splitQualityGateDiagnostics } from './reportDiagnosticsService';

const BATCHES: Array<'A' | 'B' | 'C' | 'D' | 'E'> = ['A', 'B', 'C', 'D', 'E'];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const qualityGateStatusText = (gate: QualityGateResult): string => {
  if (gate.decision === 'GO') return gate.notes[0] || 'All checks passed.';
  if (gate.decision === 'WARN') {
    return gate.fact_check?.sanitized_claims?.length
      ? 'Assessment score remains valid. Unsupported strategy wording or actions were removed or retained only in the appendix.'
      : 'Assessment score remains valid. WARN-level strategy hygiene notes are included in the appendix for traceability.';
  }
  return 'Assessment is unsafe to act on until blocking issues are resolved.';
};

const factCheckStatusText = (gate: QualityGateResult): string => {
  const fc = gate.fact_check;
  if (!fc) return 'fact-check unavailable';
  if (fc.total_claims > 0) {
    const base = `${fc.supported_count}/${fc.total_claims} claims supported`;
    return fc.partial_failure_reason ? `${base} · partial check` : base;
  }
  return fc.failed ? 'fact-check unavailable' : '0 claims checked';
};

const renderQualityGateStatus = (gate: QualityGateResult): string => {
  const supported = factCheckStatusText(gate);
  const cls = gate.decision === 'GO' ? 'qg-status-go' : gate.decision === 'BLOCK' ? 'qg-status-block' : 'qg-status-warn';
  return `
    <div class="qg-status ${cls}">
      <div>
        <span class="qg-status-label">Quality Gate Status: ${escapeHtml(gate.decision)}</span>
        <p>${escapeHtml(qualityGateStatusText(gate))}</p>
      </div>
      <span class="qg-status-meta">${escapeHtml(supported)}</span>
    </div>`;
};

const renderDiagnosticList = (
  items: string[],
  explanations?: { reason: string; explanation: string; quote?: string; source_location?: string }[]
): string => {
  if (items.length === 0) return '';
  return `<ul class="appendix-list">${items.map(item => {
    const ex = explanations?.find((it) => it.reason === item);
    return `<li>
      <strong>${escapeHtml(displayQualityGateDiagnostic(item))}</strong>
      ${ex?.explanation ? `<div class="gate-explanation">${escapeHtml(ex.explanation)}</div>` : ''}
      ${ex?.quote ? `<div class="gate-quote"><em>&ldquo;${escapeHtml(ex.quote)}&rdquo;</em>${ex.source_location ? ` — ${escapeHtml(ex.source_location)}` : ''}</div>` : ''}
    </li>`;
  }).join('')}</ul>`;
};

const renderQualityGateAppendix = (gate: QualityGateResult): string => {
  const { primaryWarnings, appendixDiagnostics } = splitQualityGateDiagnostics(gate);
  const hasFactCheckNotes = !!gate.fact_check && !gate.fact_check.failed && gate.fact_check.unsupported_claims.length > 0;
  const hasSanitizedNotes = !!gate.fact_check?.sanitized_claims?.length;
  const hasPartialFactCheck = !!gate.fact_check?.partial_failure_reason;
  const hasTrajectory = !!gate.fact_check?.trajectory && gate.fact_check.trajectory.length > 1;
  if (gate.decision === 'GO' && appendixDiagnostics.length === 0 && primaryWarnings.length === 0 && !hasFactCheckNotes) return '';
  const llm = gate.llm_explanation;
  const evidenceWarnings = primaryWarnings.filter(w => w.startsWith('Evidence-check'));
  const remainingWarnings = primaryWarnings.filter(w => !w.startsWith('Evidence-check'));
  const tacticDiagnostics = appendixDiagnostics.filter(w => w.includes('tactic grounding') || w.includes('no tactic IDs'));
  const strategyDiagnostics = appendixDiagnostics.filter(w => !tacticDiagnostics.includes(w));

  return `
  <h2>Quality &amp; Strategy Hygiene Appendix</h2>
  <div class="appendix-card">
    <p class="appendix-note">Quality Gate detail is retained here for traceability. WARN-level strategy hygiene notes do not invalidate the assessment score.</p>
    ${llm?.summary ? `<div class="gate-summary"><div class="gate-label">Reviewer Summary${llm.model_used ? ` · ${escapeHtml(llm.model_used)}` : ''}</div><p>${escapeHtml(llm.summary)}</p></div>` : ''}
    ${gate.blocking_reasons.length > 0 ? `<div class="gate-label">Blocking</div>${renderDiagnosticList(gate.blocking_reasons, llm?.blocking_details)}` : ''}
    ${hasSanitizedNotes ? `<div class="gate-label">Sanitized strategy items</div><ul class="appendix-list">${gate.fact_check!.sanitized_claims!.map(c => `<li><strong>${escapeHtml(c.action)}${c.source_location ? ` · ${escapeHtml(c.source_location)}` : ''}</strong>: <em>&ldquo;${escapeHtml(c.claim)}&rdquo;</em>${c.rationale ? `<div class="gate-rationale">${escapeHtml(c.rationale)}</div>` : ''}</li>`).join('')}</ul>` : ''}
    ${evidenceWarnings.length > 0 ? `<div class="gate-label">Evidence-check adjustments</div>${renderDiagnosticList(evidenceWarnings, llm?.warning_details)}` : ''}
    ${strategyDiagnostics.length > 0 ? `<div class="gate-label">Strategy hygiene notes</div>${renderDiagnosticList(strategyDiagnostics, llm?.warning_details)}` : ''}
    ${tacticDiagnostics.length > 0 ? `<div class="gate-label">Tactic grounding notes</div>${renderDiagnosticList(tacticDiagnostics, llm?.warning_details)}` : ''}
    ${remainingWarnings.length > 0 ? `<div class="gate-label">Remaining warnings</div>${renderDiagnosticList(remainingWarnings, llm?.warning_details)}` : ''}
    ${hasPartialFactCheck ? `<div class="gate-label">Partial fact-check status</div><ul class="appendix-list"><li><strong>${escapeHtml(gate.fact_check!.partial_failure_reason || '')}</strong></li></ul>` : ''}
    ${hasTrajectory ? `<div class="gate-label">Fact-check trajectory</div><ul class="appendix-list">${gate.fact_check!.trajectory!.map((p, i, arr) => {
      const prev = i > 0 ? arr[i - 1] : null;
      const overlap = prev
        ? p.unsupported_signatures.filter(s => prev.unsupported_signatures.some(ps => ps === s)).length
        : 0;
      return `<li><strong>pass ${p.attempt}</strong>: ${p.supported_count}/${p.total_claims} supported, ${p.unsupported_count} unsupported${prev && overlap > 0 ? `<span class="gate-rationale"> · ${overlap} claims unchanged</span>` : ''}</li>`;
    }).join('')}</ul>` : ''}
    ${hasFactCheckNotes ? `<div class="gate-label">Remaining fact-check notes</div><ul class="appendix-list">${gate.fact_check!.unsupported_claims.map(c => `<li><strong>${escapeHtml(c.source_location || 'unknown')}</strong>: <em>&ldquo;${escapeHtml(c.claim)}&rdquo;</em>${c.rationale ? `<div class="gate-rationale">${escapeHtml(c.rationale)}</div>` : ''}</li>`).join('')}</ul>` : ''}
    ${llm?.failed ? `<p class="gate-llm-failed">Reviewer narrative unavailable: ${escapeHtml(llm.failure_reason || '')}</p>` : ''}
  </div>`;
};

const statusBadgeClass = (status: string): string => {
  if (status === 'OK') return 'badge-ok';
  if (status === 'NOK') return 'badge-nok';
  if (status === 'Partial') return 'badge-partial';
  return 'badge-none';
};

const antiPatternBadgeClass = (item?: AuditItem): string => {
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'confirmed_present') return 'badge-nok';
  if (status === 'partially_present') return 'badge-partial';
  if (status === 'tested_absent') return 'badge-ok';
  return 'badge-none';
};

const evidenceCheckClass = (status?: AuditItem['evidence_check_status']): string => {
  if (status === 'supported') return 'ec-supported';
  if (status === 'weak') return 'ec-weak';
  if (status === 'unsupported') return 'ec-unsupported';
  if (status === 'missing') return 'ec-missing';
  return 'ec-missing';
};

const renderEvidenceCheckSummary = (result: DiagnosticResult): string => {
  const ec = result.evidence_check;
  if (!ec || ec.total_items === 0) return '';
  const stats: Array<[string, number]> = [
    ['Supported', ec.supported_count],
    ['Weak', ec.weak_count],
    ['Unsupported', ec.unsupported_count],
    ['Missing', ec.missing_count],
    ['Downgraded', ec.downgraded_count],
    ['Rescanned', ec.rescan_count],
  ];
  return `
  <h2>Evidence Check</h2>
  <div class="evidence-check-summary">
    ${renderQualityGateStatus(result.quality_gate)}
    <p>Phase 1 findings were verified against the raw material before Phase 2 metrics were calculated.</p>
    <div class="evidence-check-grid">
      ${stats.map(([label, value]) => `<div class="evidence-check-stat"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`).join('')}
    </div>
    ${ec.adjustments.length > 0 ? `
    <div>
      <div class="gate-label">Adjusted criteria</div>
      ${ec.adjustments.slice(0, 12).map(a => `
        <div class="evidence-check-item">
          <strong>${escapeHtml(a.stream)}.${escapeHtml(a.id)}</strong> · ${a.original_count}→${a.verified_count} · ${escapeHtml(a.status)}${a.rescan_attempted ? ' · rescanned' : ''}
          ${a.reason ? `<div class="gate-rationale">${escapeHtml(a.reason)}</div>` : ''}
        </div>
      `).join('')}
    </div>` : ''}
  </div>`;
};

const renderFindingsMode = (result: DiagnosticResult): string => {
  const findings = result.phase_3_strategy.findings_mode;
  if (!findings) return '';
  const section = (title: string, items?: string[]) => items && items.length > 0
    ? `<div class="summary-sub"><h3>${escapeHtml(title)}</h3><ul>${items.map(i => `<li>${renderInlineMarkdownHtml(i)}</li>`).join('')}</ul></div>`
    : '';
  return `
  <h2>Findings &amp; Validation Plan</h2>
  <div class="summary findings-mode">
    <p class="cg-lead">Evidence in the source did not support a directive roadmap. This section reports what the audit can confirm and what additional material is needed before a confident strategy can be written.</p>
    <div class="summary-grid">
      ${section('Evidence-backed findings', findings.evidence_backed_findings)}
      ${section('Candidate remediation themes', findings.candidate_themes)}
      ${section('Missing evidence', findings.missing_evidence)}
      ${section('Validation plan', findings.validation_plan)}
    </div>
  </div>`;
};

const renderForensicCriterion = (cat: { id: string; title: string; desc: string }, item: AuditItem | undefined, stream: 'maturity' | 'antipattern'): string => `
    <div class="forensic-card">
      <div class="forensic-head">
        <div>
          <span class="forensic-id">${escapeHtml(cat.id)}</span>
          <h4>${escapeHtml(cat.title)}</h4>
        </div>
        <span class="badge ${stream === 'antipattern' ? antiPatternBadgeClass(item) : statusBadgeClass(item?.status ?? '')}">${escapeHtml(stream === 'antipattern' ? antiPatternStatusLabel(item) : (item?.status ?? 'No Data'))}</span>
      </div>
      <p class="forensic-desc">${escapeHtml(cat.desc)}</p>
      ${stream === 'antipattern' && item?.coverage_reason ? `<div class="gate-rationale">${escapeHtml(item.coverage_reason)}</div>` : ''}
      ${item?.evidence_check_status ? `
      <div class="forensic-block">
        <span class="evidence-check-badge ${evidenceCheckClass(item.evidence_check_status)}">Evidence-check: ${escapeHtml(item.evidence_check_status)}</span>
        ${item.original_count !== undefined && item.verified_count !== undefined ? `<div class="gate-rationale">score ${item.original_count}→${item.verified_count}${item.rescan_attempted ? ' · targeted rescan' : ''}</div>` : ''}
        ${item.adjustment_reason ? `<div class="gate-rationale">${escapeHtml(item.adjustment_reason)}</div>` : ''}
      </div>` : ''}
      ${item?.reasoning ? `
      <div class="forensic-block">
        <div class="forensic-label">AI Reasoning</div>
        <p class="forensic-reasoning">${escapeHtml(item.reasoning)}</p>
      </div>` : ''}
      ${item?.evidence_quotes && item.evidence_quotes.length > 0 ? `
      <div class="forensic-block">
        <div class="forensic-label">Evidence</div>
        <ul class="forensic-quotes">
          ${item.evidence_quotes.map(q => {
            const isImage = q.evidence_source === 'image';
            const marker = isImage ? '<span class="forensic-img-marker" title="Image-derived evidence">[IMG]</span> ' : '';
            const meta: string[] = [];
            if (isImage) meta.push('visual');
            if (q.page_number !== undefined) meta.push(`page ${q.page_number}`);
            if (q.section) meta.push(escapeHtml(q.section));
            if (q.category) meta.push(escapeHtml(q.category));
            const metaHtml = meta.length > 0 ? `<span class="forensic-section"> — ${meta.join(' · ')}</span>` : '';
            return `<li class="${isImage ? 'forensic-quote-image' : ''}">${marker}&ldquo;${escapeHtml(q.quote)}&rdquo;${metaHtml}</li>`;
          }).join('')}
        </ul>
      </div>` : ''}
    </div>`;

const renderForensicSection = (
  title: string,
  stream: 'maturity' | 'antipattern',
  logs: Record<string, AuditItem>
): string => {
  const catalog = MASTER_BINGO_FINOPS[stream];
  const body = BATCHES.map(batchId => {
    const items = catalog.filter(c => c.batch === batchId);
    if (items.length === 0) return '';
    return `
    <div class="forensic-batch">
      <h3 class="forensic-batch-title">${batchId} · ${escapeHtml(BATCH_TITLES[batchId])}</h3>
      ${items.map(cat => renderForensicCriterion(cat, logs[cat.id], stream)).join('')}
    </div>`;
  }).join('');
  return `
  <h2>${escapeHtml(title)}</h2>
  ${body}`;
};

export const downloadReport = (result: DiagnosticResult) => {
  const html = generateReportHtml(result);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `FinOps_Assessment_${new Date().toISOString().split('T')[0]}.html`;
  a.click();
  URL.revokeObjectURL(url);
};

const generateReportHtml = (result: DiagnosticResult): string => {
  const m = result.phase_2_validation.metrics;
  const cwrClass = result.phase_2_validation.crawl_walk_run;
  const isBlocked = result.quality_gate.decision === 'BLOCK';
  const effectiveBracket = result.phase_3_strategy.effective_bracket ?? result.phase_3_strategy.confidence_bracket;
  const hasFindingsMode = effectiveBracket === 'LOW' && !!result.phase_3_strategy.findings_mode;
  const roadmap = result.phase_3_strategy.remediation_roadmap || [];
  const canRenderRoadmap = effectiveBracket !== 'LOW' && !isBlocked && roadmap.length > 0;
  const isInsufficientEvidence = isBlocked || m.evidence_density < 30 || m.antipattern_coverage < 60;
  const cwrSlug = cwrClass.toLowerCase().includes('insufficient') || cwrClass.toLowerCase().includes('crawl') ? 'crawl' : cwrClass.toLowerCase().includes('run') ? 'run' : 'walk';
  const readinessDescription = m.readiness_cap_reason || METRIC_DESCRIPTIONS.finops_readiness;

  const gauges = [
    { value: m.finops_readiness, label: 'Evidence-Gated Readiness', color: isBlocked ? '#f43f5e' : '#10b981', description: readinessDescription, trend: 'positive' as const, size: 'large' as const },
    { value: m.maturity_ratio, label: 'Maturity Level', color: '#14b8a6', description: METRIC_DESCRIPTIONS.maturity_ratio, trend: 'positive' as const },
    { value: m.maturity_depth, label: 'Maturity Depth', color: '#06b6d4', description: METRIC_DESCRIPTIONS.maturity_depth, trend: 'positive' as const },
    { value: m.antipattern_ratio, label: 'Anti-Pattern Level', color: '#f43f5e', description: METRIC_DESCRIPTIONS.antipattern_ratio, trend: 'negative' as const },
    { value: m.antipattern_burden, label: 'Anti-Pattern Burden', color: '#e11d48', description: METRIC_DESCRIPTIONS.antipattern_burden, trend: 'negative' as const },
    { value: m.antipattern_clearance, label: 'Anti-Pattern Clearance', color: '#10b981', description: METRIC_DESCRIPTIONS.antipattern_clearance, trend: 'positive' as const },
    { value: m.antipattern_coverage, label: 'Anti-Pattern Coverage', color: '#64748b', description: METRIC_DESCRIPTIONS.antipattern_coverage, trend: 'positive' as const },
    { value: m.delivery_integrity, label: 'Delivery Integrity', color: '#475569', description: METRIC_DESCRIPTIONS.delivery_integrity, trend: 'positive' as const },
    { value: m.evidence_density, label: 'Evidence Density', color: '#475569', description: METRIC_DESCRIPTIONS.evidence_density, trend: 'positive' as const }
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinOps Maturity Assessment Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #ffffff; color: #0f172a; padding: 48px 32px; max-width: 1100px; margin: 0 auto; line-height: 1.55; }
    h1 { font-size: 2.25rem; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; font-weight: 700; color: #0f172a; margin: 3rem 0 1.25rem; padding-bottom: 0.6rem; border-bottom: 1px solid #e2e8f0; }
    h3 { font-size: 1.1rem; font-weight: 700; color: #0f172a; }
    p { color: #334155; }
    .meta { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
    .meta p { color: #64748b; }
    .classification-panel { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 1.25rem; padding: 2rem; margin: 1rem 0 2rem; }
    .classification-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .classification { font-size: 1rem; font-weight: 700; padding: 0.5rem 1rem; border-radius: 0.5rem; display: inline-block; }
    .classification.crawl { background: #ffe4e6; color: #be123c; }
    .classification.walk { background: #fef3c7; color: #b45309; }
    .classification.run { background: #d1fae5; color: #047857; }
    .classification-pipe { color: #cbd5e1; }
    .classification-meta { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; color: #64748b; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
    .metric { display: flex; flex-direction: column; }
    .metric-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 0.25rem; }
    .metric-value { font-size: 2rem; font-weight: 800; line-height: 1; }
    .metric-value.emerald { color: #059669; }
    .metric-value.teal { color: #0d9488; }
    .metric-value.rose { color: #e11d48; }
    .metric-value.violet { color: #7c3aed; }
    .metric-desc { font-size: 0.8rem; color: #64748b; margin-top: 0.5rem; line-height: 1.45; }
    .gauge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; margin: 1.5rem 0 2rem; align-items: stretch; }
    .gauge-grid > .gauge-large { grid-column: span 2; }
    .chart-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 1.25rem; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 2rem; line-height: 1.75; color: #334155; margin-bottom: 1.5rem; }
    .summary strong { color: #0f172a; }
    .summary em { color: #047857; font-style: normal; font-weight: 600; }
    .summary-markdown { text-align: left; }
    .summary-paragraph { margin: 0 0 1.5rem 0; text-align: left; }
    .summary-paragraph:last-child { margin-bottom: 0; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .summary-sub h3 { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin: 0 0 0.5rem 0; }
    .summary-sub ul { margin: 0; padding-left: 1.25rem; }
    .summary-sub li { font-size: 0.875rem; margin-bottom: 0.35rem; }
    .persona-heading { font-size: 0.875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #047857; margin: 0.5rem 0 0.75rem 0; }
    .confidence-notes { background: #fffbeb; border: 1px solid #fde68a; border-radius: 0.75rem; padding: 1rem 1.25rem; margin: 0.5rem 0 1.5rem 0; }
    .confidence-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #b45309; margin: 0 0 0.5rem 0; }
    .confidence-lead { font-size: 0.8125rem; color: #92400e; margin: 0 0 0.75rem 0; }
    .confidence-notes ul { list-style: none; padding: 0; margin: 0; }
    .confidence-notes li { margin-bottom: 0.5rem; color: #78350f; font-size: 0.875rem; }
    .cn-claim { font-style: italic; display: block; }
    .cn-rationale { display: block; font-size: 0.75rem; color: #b45309; margin-top: 0.125rem; }
    .coverage-gaps { background: #fffbeb; border: 1px solid #fde68a; border-radius: 1rem; padding: 1.5rem 2rem; margin-bottom: 2rem; }
    .cg-lead { font-size: 0.875rem; color: #475569; margin: 0 0 1rem 0; }
    .cg-group { margin-bottom: 1rem; }
    .cg-type { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #b45309; margin: 0 0 0.5rem 0; }
    .coverage-gaps ul { margin: 0; padding-left: 1.25rem; }
    .coverage-gaps li { font-size: 0.875rem; color: #334155; margin-bottom: 0.25rem; }
    .roadmap-phase { background: #ffffff; border: 1px solid #e2e8f0; border-left: 3px solid #10b981; padding: 1.25rem 1.5rem; margin: 1rem 0; border-radius: 0 0.75rem 0.75rem 0; }
    .roadmap-phase h3 { color: #0f172a; margin-bottom: 0.75rem; font-size: 1rem; }
    .roadmap-context { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
    .roadmap-context-block { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.65rem; padding: 0.8rem; }
    .roadmap-context-label { font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 0.35rem; }
    .roadmap-context-block p { font-size: 0.85rem; color: #334155; margin: 0; }
    .roadmap-how-label { font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin: 0.75rem 0 0.4rem; }
    .roadmap-phase ul { list-style: none; padding: 0; margin: 0; }
    .roadmap-phase li { display: flex; gap: 0.6rem; padding: 0.35rem 0; font-size: 0.9rem; color: #334155; }
    .roadmap-phase li:before { content: ""; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: #10b981; margin-top: 0.55rem; }
    .forensic-batch { margin: 2rem 0; }
    .forensic-batch-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.15em; color: #64748b; font-weight: 700; margin: 1.5rem 0 0.75rem; }
    .forensic-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 0.875rem; padding: 1.25rem; margin: 0.75rem 0; }
    .forensic-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 0.5rem; }
    .forensic-head h4 { font-size: 1rem; color: #0f172a; line-height: 1.3; margin-top: 0.125rem; font-weight: 700; }
    .forensic-id { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.75rem; color: #94a3b8; }
    .badge { padding: 0.25rem 0.55rem; border-radius: 0.4rem; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; flex-shrink: 0; }
    .badge-ok { background: #d1fae5; color: #047857; }
    .badge-partial { background: #fef3c7; color: #b45309; }
    .badge-nok { background: #ffe4e6; color: #be123c; }
    .badge-none { background: #f1f5f9; color: #64748b; }
    .evidence-check-summary { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.5rem; margin: 1.5rem 0 2rem; }
    .qg-status { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border-radius: 0.75rem; padding: 1rem; margin-bottom: 1rem; border: 1px solid; }
    .qg-status p { margin: 0.2rem 0 0 0; font-size: 0.85rem; }
    .qg-status-label { display: block; font-size: 0.75rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; }
    .qg-status-meta { font-size: 0.75rem; font-weight: 700; white-space: nowrap; }
    .qg-status-go { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
    .qg-status-warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
    .qg-status-block { background: #fef2f2; border-color: #fecdd3; color: #991b1b; }
    .evidence-check-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
    .evidence-check-stat { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.8rem; }
    .evidence-check-stat span { display: block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; }
    .evidence-check-stat strong { display: block; font-size: 1.5rem; margin-top: 0.15rem; }
    .evidence-check-item { font-size: 0.85rem; color: #334155; padding-left: 0.75rem; border-left: 2px solid #cbd5e1; margin: 0.45rem 0; }
    .evidence-check-badge { display: inline-block; margin: 0.35rem 0 0.25rem; padding: 0.25rem 0.5rem; border-radius: 0.4rem; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    .ec-supported { background: #d1fae5; color: #047857; }
    .ec-weak { background: #fef3c7; color: #b45309; }
    .ec-unsupported { background: #ffe4e6; color: #be123c; }
    .ec-missing { background: #f1f5f9; color: #475569; }
    .forensic-desc { font-size: 0.875rem; color: #64748b; margin: 0.5rem 0 0.75rem; }
    .forensic-block { margin-top: 0.75rem; }
    .forensic-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; font-weight: 700; margin-bottom: 0.4rem; }
    .forensic-reasoning { font-size: 0.875rem; color: #334155; white-space: pre-line; }
    .forensic-quotes { list-style: none; padding: 0; margin: 0; }
    .forensic-quotes li { font-size: 0.875rem; font-style: italic; color: #475569; border-left: 2px solid #cbd5e1; padding-left: 0.75rem; margin: 0.5rem 0; }
    .forensic-quotes li.forensic-quote-image { border-left-color: #c4b5fd; color: #4c1d95; background: #faf5ff; }
    .forensic-section { font-size: 0.75rem; color: #94a3b8; font-style: normal; }
    .forensic-img-marker { display: inline-block; font-size: 0.65rem; font-weight: 700; font-style: normal; padding: 0.05rem 0.35rem; border-radius: 0.25rem; background: #ede9fe; color: #6d28d9; margin-right: 0.4rem; vertical-align: middle; }
    .appendix-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.25rem; }
    .appendix-note { font-size: 0.875rem; color: #64748b; margin: 0.4rem 0 1rem; }
    .appendix-list { padding-left: 1.25rem; color: #334155; }
    .appendix-list li { margin: 0.6rem 0; font-size: 0.875rem; }
    .gate { padding: 1.25rem 1.5rem; border-radius: 0.875rem; margin: 1rem 0 2rem; border-left: 4px solid; }
    .gate.gate-go { background: #ecfdf5; border-color: #10b981; color: #065f46; font-size: 0.875rem; }
    .gate.gate-warn { background: #fffbeb; border-color: #f59e0b; color: #92400e; }
    .gate.gate-block { background: #fef2f2; border-color: #ef4444; color: #991b1b; }
    .gate-title { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; }
    .gate-note { font-size: 0.9rem; margin-bottom: 1rem; opacity: 0.95; }
    .gate-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; margin: 0.75rem 0 0.5rem; opacity: 0.85; }
    .gate ul { list-style: none; padding: 0; margin: 0; }
    .gate li { padding-left: 0.75rem; border-left: 2px solid currentColor; margin: 0.4rem 0; opacity: 0.95; font-size: 0.875rem; }
    .gate-factcheck { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(0,0,0,0.1); }
    .gate-rationale { font-size: 0.75rem; opacity: 0.75; font-style: normal; }
    .gate-summary { margin: 0.75rem 0; padding: 0.75rem; background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.08); border-radius: 6px; }
    .gate-summary p { margin: 0; font-size: 0.875rem; }
    .gate-explanation { font-size: 0.78rem; opacity: 0.8; margin-top: 0.25rem; }
    .gate-quote { font-size: 0.78rem; opacity: 0.8; margin-top: 0.25rem; }
    .gate-llm-failed { font-size: 0.75rem; opacity: 0.6; font-style: italic; margin-top: 0.75rem; }
    .footer { text-align: center; padding: 2rem 0; margin-top: 3rem; border-top: 1px solid #e2e8f0; font-size: 0.85rem; color: #94a3b8; }
    ${SVG_CSS}
    @media print {
      body { padding: 24px; max-width: none; }
      h2 { page-break-after: avoid; }
      .forensic-card, .roadmap-phase, .gauge-card, .chart-card { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>FinOps Maturity Assessment</h1>
  <div class="meta">
    <p>Generated ${escapeHtml(result.meta.timestamp)} · Engine ${escapeHtml(result.meta.engine_version)}</p>
    <p>Models: ${escapeHtml(result.meta.model_config.preflight)} (Pre-Flight) · ${escapeHtml(result.meta.model_config.forensic_audit)} (Audit) · ${escapeHtml(result.meta.model_config.evidence_check)} (Evidence Check) · ${escapeHtml(result.meta.model_config.synthesis)} (Summary/Diagnosis)${result.meta.model_config.roadmap_synthesis ? ` · ${escapeHtml(result.meta.model_config.roadmap_synthesis)} (Roadmap)` : ''} · ${escapeHtml(result.meta.model_config.fact_check)} (Fact-Check)</p>
    ${(result.meta.source_parse_warnings?.length ?? 0) > 0 ? `<p>Source parse note: ${escapeHtml(result.meta.source_parse_warnings![0])}${result.meta.source_parse_warnings!.length > 1 ? ` (+${result.meta.source_parse_warnings!.length - 1} more)` : ''}</p>` : ''}
  </div>

  ${renderEvidenceCheckSummary(result)}

  <div class="classification-panel">
    <div class="classification-row">
      <span class="classification ${cwrSlug}">${escapeHtml(cwrClass)}</span>
      <span class="classification-pipe">|</span>
      <span class="classification-meta">Delivery ${m.delivery_integrity}% · Evidence ${m.evidence_density}%</span>
    </div>
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">Evidence-Gated Readiness</div>
        <div class="metric-value ${isBlocked ? 'rose' : 'emerald'}">${Math.round(m.finops_readiness)}%</div>
        <div class="metric-desc">${escapeHtml(readinessDescription)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Maturity Depth</div>
        <div class="metric-value teal">${Math.round(m.maturity_depth)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.maturity_depth)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Anti-Pattern Burden</div>
        <div class="metric-value rose">${Math.round(m.antipattern_burden)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.antipattern_burden)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Anti-Pattern Clearance</div>
        <div class="metric-value emerald">${Math.round(m.antipattern_clearance)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.antipattern_clearance)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Anti-Pattern Coverage</div>
        <div class="metric-value">${Math.round(m.antipattern_coverage)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.antipattern_coverage)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Maturity Ratio</div>
        <div class="metric-value violet">${Math.round(m.maturity_ratio)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.maturity_ratio)}</div>
      </div>
    </div>
  </div>

  <h2>Maturity Gauges</h2>
  <div class="gauge-grid">
    ${gauges.map(g => svgGaugeCard(g)).join('')}
  </div>

  <h2>Visual Diagnosis</h2>
  <div class="chart-row">
    <div class="chart-card">
      <h3>Category Footprint</h3>
      <p class="chart-desc">Per-domain maturity (emerald) vs anti-pattern burden (rose). Each axis is one of the five batches; values are the sum of sub-criterion counts (0–15) for that batch.</p>
      ${svgRadar(result.phase_1_audit_logs)}
    </div>
    <div class="chart-card">
      <h3>Position vs. Quadrants</h3>
      <p class="chart-desc">Validated maturity depth (x-axis) plotted against confirmed anti-pattern burden (y-axis). When evidence or anti-pattern coverage is insufficient, quadrant labels are suppressed.</p>
      ${svgScatter(m.maturity_depth, m.antipattern_burden, isInsufficientEvidence)}
    </div>
  </div>

  <h2>Evidence Summary</h2>
  ${(() => {
    const evidence = result.phase_3_strategy.evidence_summary;
    if (!evidence) return '';
    const useSourceObservationTitle = isInsufficientEvidenceReport(
      evidence.maturity_classification,
      m.evidence_density,
      result.quality_gate.decision
    );
    const list = (title: string, items?: string[]) => items && items.length > 0
      ? `<div class="summary-sub"><h3>${escapeHtml(title)}</h3><ul>${items.map(i => `<li>${renderInlineMarkdownHtml(i)}</li>`).join('')}</ul></div>`
      : '';
    return `
      <div class="summary evidence-summary">
        <p class="persona-heading">Fact-only current state · ${escapeHtml(evidence.maturity_classification)}</p>
        <h3>${escapeHtml(evidence.headline)}</h3>
        <div class="summary-grid">
          ${list('Key metrics', evidence.key_metrics)}
          ${list(strengthsSectionTitle(useSourceObservationTitle), evidence.confirmed_strengths)}
          ${list('Confirmed gaps', evidence.confirmed_gaps)}
          ${list('Confirmed anti-patterns', evidence.confirmed_antipatterns)}
          ${list('Verified anti-pattern absences', result.phase_2_validation.verified_antipattern_absences)}
          ${list('Anti-patterns not assessable from source', result.phase_2_validation.unknown_antipattern_absences)}
          ${list('Silent / missing evidence', evidence.silent_or_missing_evidence)}
        </div>
      </div>`;
  })()}
  ${(() => {
    const summaries = result.phase_3_strategy.executive_summaries;
    const personas: Array<{ id: 'finops_lead' | 'cfo' | 'engineering_lead'; label: string }> = [
      { id: 'finops_lead', label: 'FinOps Lead' },
      { id: 'cfo', label: 'CFO' },
      { id: 'engineering_lead', label: 'Engineering Lead' }
    ];
    const unsupported = result.quality_gate?.fact_check?.unsupported_claims || [];
    const attempts = result.quality_gate?.fact_check?.attempts || 0;
    const renderConfidence = (personaId: string): string => {
      const personaClaims = unsupported.filter(c => c.source_location === personaId);
      if (personaClaims.length === 0) return '';
      return `
        <div class="confidence-notes">
          <p class="confidence-title">Confidence Notes — Unverified Claims</p>
          <p class="confidence-lead">The following statements could not be verified against the source after ${attempts} regenerate pass(es). Treat with caution.</p>
          <ul>
            ${personaClaims.map(c => `<li><span class="cn-claim">&ldquo;${escapeHtml(c.claim)}&rdquo;</span><span class="cn-rationale">${escapeHtml(c.rationale)}${c.failure_type ? ` · ${escapeHtml(c.failure_type.replace(/_/g, ' '))}` : ''}</span></li>`).join('')}
          </ul>
        </div>`;
    };
    if (summaries && personas.some(p => summaries[p.id])) {
      return personas.map(p => `
        <h3 class="persona-heading">Evidence summary for the ${escapeHtml(p.label)}</h3>
        <div class="summary summary-markdown">${renderMarkdownSummaryHtml(summaries[p.id] || '')}</div>
        ${renderConfidence(p.id)}
      `).join('');
    }
    return `<div class="summary summary-markdown">${renderMarkdownSummaryHtml(result.phase_3_strategy.executive_summary || '')}</div>`;
  })()}

  ${(() => {
    const diagnosis = result.phase_3_strategy.diagnosis;
    if (!diagnosis) return '';
    return `
      <h2>Diagnosis</h2>
      <div class="summary diagnosis">
        <p class="persona-heading">Interpretation of evidence — not the implementation plan</p>
        <h3>Primary bottleneck</h3>
        <p>${escapeHtml(diagnosis.primary_bottleneck)}</p>
        <div class="summary-grid">
          <div class="summary-sub"><h3>Root causes</h3><ul>${(diagnosis.root_causes || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>
          <div class="summary-sub"><h3>Domain diagnosis</h3><ul>${Object.entries(diagnosis.domain_diagnosis || {}).map(([d, text]) => `<li><strong>${escapeHtml(d)}:</strong> ${escapeHtml(text)}</li>`).join('')}</ul></div>
        </div>
        <p><strong>Confidence (${escapeHtml(diagnosis.confidence)}):</strong> ${escapeHtml(diagnosis.confidence_rationale)}</p>
      </div>`;
  })()}

  ${(() => {
    const decision = result.phase_3_strategy.planning_decision;
    if (!decision) return '';
    return `
      <h2>Planning Decision: ${escapeHtml(decision.decision?.replace('_', ' ') || '')}</h2>
      <div class="summary planning-decision">
        <p>${escapeHtml(decision.rationale)}</p>
        <div class="summary-grid">
          <div class="summary-sub"><h3>Safe to act on</h3><ul>${(decision.safe_to_act_on || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>
          <div class="summary-sub"><h3>Evidence needed before action</h3><ul>${(decision.evidence_needed_before_action || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>
        </div>
      </div>`;
  })()}

  ${(() => {
    const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
    const withMaterial = claims.filter(c => c.missing_material);
    if (withMaterial.length === 0) return '';
    const byType: Record<string, string[]> = {};
    for (const c of withMaterial) {
      const key = c.failure_type ? c.failure_type.replace(/_/g, ' ') : 'other';
      (byType[key] ||= []).push(c.missing_material!);
    }
    return `
      <h2>Source Coverage Gaps</h2>
      <div class="coverage-gaps">
        <p class="cg-lead">To strengthen the next assessment cycle, include the following kinds of evidence in the source document.</p>
        ${Object.entries(byType).map(([type, materials]) => `
          <div class="cg-group">
            <p class="cg-type">${escapeHtml(type)}</p>
            <ul>${Array.from(new Set(materials)).map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
          </div>
        `).join('')}
      </div>`;
  })()}

  ${hasFindingsMode ? renderFindingsMode(result) : ''}
  ${canRenderRoadmap ? `
    <h2>Remediation Roadmap</h2>
    ${roadmap.map(step => `
      <div class="roadmap-phase">
        <h3>${escapeHtml(step.phase)}</h3>
        ${step.why || step.what ? `<div class="roadmap-context">
          ${step.why ? `<div class="roadmap-context-block"><div class="roadmap-context-label">Why</div><p>${escapeHtml(step.why)}</p></div>` : ''}
          ${step.what ? `<div class="roadmap-context-block"><div class="roadmap-context-label">What</div><p>${escapeHtml(step.what)}</p></div>` : ''}
        </div>` : ''}
        <div class="roadmap-how-label">How</div>
        <ul>${step.actions.map(a => `<li><span>${escapeHtml(a)}</span></li>`).join('')}</ul>
      </div>
    `).join('')}
  ` : (effectiveBracket === 'LOW' || isBlocked) && !hasFindingsMode ? `
    <h2>Remediation Roadmap</h2>
    <div class="coverage-gaps">
      <p class="cg-lead">Directive roadmap actions were withheld because the effective confidence bracket is LOW or the Quality Gate blocked the generated plan. Use the evidence summary, planning decision, and validation plan before acting.</p>
    </div>
  ` : ''}

  ${renderForensicSection('Forensic Audit: FinOps Maturity', 'maturity', result.phase_1_audit_logs.maturity)}
  ${renderForensicSection('Forensic Audit: Anti-Patterns', 'antipattern', result.phase_1_audit_logs.antipattern)}
  ${renderQualityGateAppendix(result.quality_gate)}

  <div class="footer">
    <p>FinOps Assessment Engine v${escapeHtml(result.meta.engine_version)}</p>
  </div>

  <script id="finops-data" type="application/json">${JSON.stringify(result)}</script>
</body>
</html>`;
};
