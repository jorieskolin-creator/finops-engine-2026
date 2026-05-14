
import { AuditItem, DiagnosticResult, QualityGateResult } from '../types';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { METRIC_DESCRIPTIONS } from '../constants';
import { SVG_CSS, svgGaugeCard, svgRadar, svgScatter } from './svgChartService';

const BATCHES: Array<'A' | 'B' | 'C' | 'D' | 'E'> = ['A', 'B', 'C', 'D', 'E'];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const renderQualityGate = (gate: QualityGateResult): string => {
  if (gate.decision === 'GO') {
    return `<div class="gate gate-go"><strong>Quality Gate: GO</strong> — ${escapeHtml(gate.notes[0] ?? '')}</div>`;
  }
  const cls = gate.decision === 'BLOCK' ? 'gate-block' : 'gate-warn';
  return `
  <div class="gate ${cls}">
    <h2 class="gate-title">Quality Gate: ${gate.decision}</h2>
    <p class="gate-note">${escapeHtml(gate.notes[0] ?? '')}</p>
    ${gate.blocking_reasons.length > 0 ? `
    <div class="gate-block-section">
      <div class="gate-label">Blocking</div>
      <ul>${gate.blocking_reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </div>` : ''}
    ${gate.warnings.length > 0 ? `
    <div class="gate-warn-section">
      <div class="gate-label">Warnings</div>
      <ul>${gate.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
    </div>` : ''}
    ${gate.fact_check && !gate.fact_check.failed && gate.fact_check.unsupported_claims.length > 0 ? `
    <div class="gate-factcheck">
      <div class="gate-label">Unverified claims (${gate.fact_check.unsupported_claims.length} survived ${gate.fact_check.attempts} pass${gate.fact_check.attempts === 1 ? '' : 'es'})</div>
      <ul>${gate.fact_check.unsupported_claims.map(c => `<li><em>&ldquo;${escapeHtml(c.claim)}&rdquo;</em>${c.rationale ? `<span class="gate-rationale"> — ${escapeHtml(c.rationale)}</span>` : ''}</li>`).join('')}</ul>
    </div>` : ''}
  </div>`;
};

const statusBadgeClass = (status: string): string => {
  if (status === 'OK') return 'badge-ok';
  if (status === 'NOK') return 'badge-nok';
  if (status === 'Partial') return 'badge-partial';
  return 'badge-none';
};

const renderForensicCriterion = (cat: { id: string; title: string; desc: string }, item: AuditItem | undefined): string => `
    <div class="forensic-card">
      <div class="forensic-head">
        <div>
          <span class="forensic-id">${escapeHtml(cat.id)}</span>
          <h4>${escapeHtml(cat.title)}</h4>
        </div>
        <span class="badge ${statusBadgeClass(item?.status ?? '')}">${escapeHtml(item?.status ?? 'No Data')}</span>
      </div>
      <p class="forensic-desc">${escapeHtml(cat.desc)}</p>
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
      ${items.map(cat => renderForensicCriterion(cat, logs[cat.id])).join('')}
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
  const cwrSlug = cwrClass.toLowerCase().includes('crawl') ? 'crawl' : cwrClass.toLowerCase().includes('run') ? 'run' : 'walk';

  const gauges = [
    { value: m.finops_readiness, label: 'FinOps Readiness', color: '#10b981', description: METRIC_DESCRIPTIONS.finops_readiness, trend: 'positive' as const, size: 'large' as const },
    { value: m.maturity_ratio, label: 'Maturity Level', color: '#14b8a6', description: METRIC_DESCRIPTIONS.maturity_ratio, trend: 'positive' as const },
    { value: m.maturity_depth, label: 'Maturity Depth', color: '#06b6d4', description: METRIC_DESCRIPTIONS.maturity_depth, trend: 'positive' as const },
    { value: m.antipattern_ratio, label: 'Anti-Pattern Level', color: '#f43f5e', description: METRIC_DESCRIPTIONS.antipattern_ratio, trend: 'negative' as const },
    { value: m.antipattern_burden, label: 'Anti-Pattern Burden', color: '#e11d48', description: METRIC_DESCRIPTIONS.antipattern_burden, trend: 'negative' as const },
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
    .forensic-desc { font-size: 0.875rem; color: #64748b; margin: 0.5rem 0 0.75rem; }
    .forensic-block { margin-top: 0.75rem; }
    .forensic-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; font-weight: 700; margin-bottom: 0.4rem; }
    .forensic-reasoning { font-size: 0.875rem; color: #334155; white-space: pre-line; }
    .forensic-quotes { list-style: none; padding: 0; margin: 0; }
    .forensic-quotes li { font-size: 0.875rem; font-style: italic; color: #475569; border-left: 2px solid #cbd5e1; padding-left: 0.75rem; margin: 0.5rem 0; }
    .forensic-quotes li.forensic-quote-image { border-left-color: #c4b5fd; color: #4c1d95; background: #faf5ff; }
    .forensic-section { font-size: 0.75rem; color: #94a3b8; font-style: normal; }
    .forensic-img-marker { display: inline-block; font-size: 0.65rem; font-weight: 700; font-style: normal; padding: 0.05rem 0.35rem; border-radius: 0.25rem; background: #ede9fe; color: #6d28d9; margin-right: 0.4rem; vertical-align: middle; }
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
    <p>Models: ${escapeHtml(result.meta.model_config.phase0_phase1)} (Audit) · ${escapeHtml(result.meta.model_config.phase3)} (Strategy)</p>
  </div>

  ${renderQualityGate(result.quality_gate)}

  <div class="classification-panel">
    <div class="classification-row">
      <span class="classification ${cwrSlug}">${escapeHtml(cwrClass)}</span>
      <span class="classification-pipe">|</span>
      <span class="classification-meta">Delivery ${m.delivery_integrity}% · Evidence ${m.evidence_density}%</span>
    </div>
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">FinOps Readiness</div>
        <div class="metric-value emerald">${Math.round(m.finops_readiness)}%</div>
        <div class="metric-desc">${escapeHtml(METRIC_DESCRIPTIONS.finops_readiness)}</div>
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
      <p class="chart-desc">FinOps Readiness (x-axis) plotted against Anti-Pattern Burden (y-axis). The bottom-right quadrant is the goal: high readiness, low burden.</p>
      ${svgScatter(m.finops_readiness, m.antipattern_burden)}
    </div>
  </div>

  <h2>Executive Summary</h2>
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
        <h3 class="persona-heading">For the ${escapeHtml(p.label)}</h3>
        <div class="summary">${(summaries[p.id] || '').replace(/\n/g, '<br>')}</div>
        ${renderConfidence(p.id)}
      `).join('');
    }
    return `<div class="summary">${(result.phase_3_strategy.executive_summary || '').replace(/\n/g, '<br>')}</div>`;
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

  <h2>Remediation Roadmap</h2>
  ${result.phase_3_strategy.remediation_roadmap.map(step => `
    <div class="roadmap-phase">
      <h3>${escapeHtml(step.phase)}</h3>
      <ul>${step.actions.map(a => `<li><span>${escapeHtml(a)}</span></li>`).join('')}</ul>
    </div>
  `).join('')}

  ${renderForensicSection('Forensic Audit: FinOps Maturity', 'maturity', result.phase_1_audit_logs.maturity)}
  ${renderForensicSection('Forensic Audit: Anti-Patterns', 'antipattern', result.phase_1_audit_logs.antipattern)}

  <div class="footer">
    <p>FinOps Assessment Engine v${escapeHtml(result.meta.engine_version)}</p>
  </div>

  <script id="finops-data" type="application/json">${JSON.stringify(result)}</script>
</body>
</html>`;
};
