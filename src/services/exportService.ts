
import { AuditItem, DiagnosticResult, QualityGateResult } from '../types';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { SVG_CSS, svgGaugeCard } from './svgChartService';
import {
  displayPlanningDecisionRationale,
  displaySourceCoverageWarning,
  isInsufficientEvidenceReport,
  renderInlineMarkdownHtml,
  strengthsSectionTitle
} from './reportTextService';
import { antiPatternStatusLabel, inferAntiPatternAbsenceStatus } from './antiPatternSemantics';
import { displayQualityGateDiagnostic, isReportableSourceCoverageGap, splitQualityGateDiagnostics } from './reportDiagnosticsService';
import { serializeDiagnosticResultForHtml } from './reportImportService';
import { computeDomainSignalRows, DomainSignalTone } from './domainSignalService';
import { buildReportViewModel, MATURITY_SCORE_METHOD_NOTE } from './reportViewModel';
import { stripSourceFilenameMetadata } from './privacyService';

const BATCHES = Object.keys(BATCH_TITLES);
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

const formatNumber = (value: number): string => Number.isFinite(value) ? value.toLocaleString('en-US') : '0';

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
    ${llm?.summary ? `<div class="gate-summary"><div class="gate-label">Reviewer Summary</div><p>${escapeHtml(llm.summary)}</p></div>` : ''}
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

const renderSourceRegistryPacketSummary = (result: DiagnosticResult): string => {
  const trace = result.meta.run_trace;
  const registry = result.meta.source_registry;
  if (!trace && !registry) return '';

  const sourceCount = trace ? trace.input_manifest.length : registry?.source_count || 0;
  const chunkCount = trace
    ? trace.input_manifest.reduce((sum, source) => sum + source.chunk_count, 0)
    : registry?.chunk_count || 0;
  const dlpReviewChunks = trace?.dlp.model_review_chunk_count ?? registry?.dlp_review_chunk_count ?? 0;
  const highRiskHits = trace?.dlp.high_risk_hit_count ?? registry?.dlp_high_risk_hits ?? 0;
  const cautionHits = trace?.dlp.caution_hit_count ?? registry?.dlp_caution_hits ?? 0;
  const packets = trace
    ? Object.fromEntries(trace.context_packets.map(packet => [packet.domain_id, packet]))
    : registry?.packets || {};
  const packetRows = BATCHES
    .map(domain => {
      const packet = packets[domain];
      if (!packet) return null;
      return {
        domain,
        title: BATCH_TITLES[domain] || domain,
        included: packet.included_chunk_count || 0,
        candidates: packet.total_candidate_chunks || 0,
        weakCoverage: !!packet.weak_coverage,
        chars: packet.char_count || 0,
        notes: 'coverage_notes' in packet ? packet.coverage_notes || [] : []
      };
    })
    .filter((row): row is {
      domain: string;
      title: string;
      included: number;
      candidates: number;
      weakCoverage: boolean;
      chars: number;
      notes: string[];
    } => !!row);

  if (sourceCount === 0 && chunkCount === 0 && packetRows.length === 0) return '';

  const metricRows: Array<[string, string]> = [
    ['Source documents', formatNumber(sourceCount)],
    ['Parsed chunks', formatNumber(chunkCount)],
    ['DLP review chunks', formatNumber(dlpReviewChunks)],
    ['High-risk DLP hits', formatNumber(highRiskHits)],
    ['Caution DLP hits', formatNumber(cautionHits)]
  ];

  return `
  <section class="source-packet-section">
    <h2>Source Registry &amp; Context Packets</h2>
    <div class="source-packet-card">
      <p class="source-packet-note">This snapshot shows how parsed source material was chunked, sampled for DLP review, and routed into A-F context packets before model audit. Included/candidate ratios measure retrieval candidate inclusion, not evidence coverage. A packet can include every routed candidate and still have weak substantive evidence. Findings still require verified source evidence.</p>
      <div class="source-packet-tables">
        <table class="source-packet-table source-packet-metrics-table">
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>
            ${metricRows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}
          </tbody>
        </table>
        ${packetRows.length > 0 ? `
        <table class="source-packet-table">
          <thead><tr><th>Packet</th><th>Included chunks</th><th>Candidate chunks</th><th>Evidence sufficiency</th><th>Characters</th></tr></thead>
          <tbody>
            ${packetRows.map(row => `
              <tr>
                <td><strong>${escapeHtml(row.domain)}</strong><span>${escapeHtml(row.title)}</span></td>
                <td>${formatNumber(row.included)}</td>
                <td>${formatNumber(row.candidates)}</td>
                <td><span class="packet-coverage ${row.weakCoverage ? 'packet-coverage-weak' : 'packet-coverage-ok'}">${row.weakCoverage ? 'Weak coverage' : 'OK'}</span></td>
                <td>${formatNumber(row.chars)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : ''}
      </div>
      ${packetRows.some(row => row.notes.length > 0) ? `
        <ul class="source-packet-notes">
          ${packetRows.filter(row => row.notes.length > 0).map(row => `<li><strong>${escapeHtml(row.domain)}:</strong> ${escapeHtml(row.notes[0])}</li>`).join('')}
        </ul>` : ''}
    </div>
  </section>`;
};

const renderAcquisitionQuality = (result: DiagnosticResult): string => {
  const quality = result.meta.acquisition_quality;
  if (!quality) return '';
  const coverage = quality.evidence.coverage;
  const density = quality.evidence.density;
  const provenance = quality.evidence.provenance;
  const statusClass = (ready: boolean) => ready ? 'packet-coverage-ok' : 'packet-coverage-weak';
  const metricRows: Array<[string, string]> = [
    ['Extraction completeness', `${quality.extraction.overall_completeness}% · ${quality.extraction.status}`],
    ['Evidence coverage', `${coverage.overall}% · ${coverage.covered_items}/${coverage.total_items} objects`],
    ['Evidence density', `${density.overall}%`],
    ['Verified evidence strength', `${density.verified_strength}%`],
    ['Source diversity', `${density.source_diversity}%`],
    ['Evidence-category diversity', `${density.category_diversity}%`],
    ['Provenance integrity', `${provenance.integrity}% · ${provenance.source_backed_count} source-backed / ${provenance.asserted_count} unresolved`],
    ['KB completeness', `${quality.knowledge.completeness}% · ${quality.knowledge.loaded_document_count}/${quality.knowledge.expected_document_count} objects`],
    ['Security gate', `${quality.security.status} · ${quality.security.caution_hit_count} caution / ${quality.security.high_risk_hit_count} high-risk hit(s)`]
  ];
  const domainRows = Object.entries(coverage.by_domain).sort(([a], [b]) => a.localeCompare(b));
  const blockingReasons = quality.readiness.blocking_reasons.slice(0, 30);

  return `
  <section class="source-packet-section">
    <h2>Acquisition Quality &amp; Readiness</h2>
    <div class="source-packet-card">
      <p class="source-packet-note">Versioned acquisition telemetry (${escapeHtml(quality.formula_version)}). Evidence coverage measures how much of the assessment surface was tested; evidence density separately combines verified strength (60%), per-object source diversity (20%), and evidence-category diversity (20%). These readiness values are observability-only in this milestone and do not alter scores or the Quality Gate.</p>
      <div class="source-packet-tables">
        <table class="source-packet-table source-packet-metrics-table">
          <thead><tr><th>Quality measure</th><th>Value</th></tr></thead>
          <tbody>${metricRows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody>
        </table>
        <table class="source-packet-table">
          <thead><tr><th>Readiness</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Evidence Packet</td><td><span class="packet-coverage ${statusClass(quality.readiness.evidence_packet === 'READY')}">${quality.readiness.evidence_packet}</span></td></tr>
            <tr><td>Knowledge Packet</td><td><span class="packet-coverage ${statusClass(quality.readiness.knowledge_packet === 'READY')}">${quality.readiness.knowledge_packet}</span></td></tr>
            <tr><td>Overall acquisition</td><td><span class="packet-coverage ${statusClass(quality.readiness.acquisition === 'READY')}">${quality.readiness.acquisition}</span></td></tr>
          </tbody>
        </table>
        ${domainRows.length > 0 ? `
        <table class="source-packet-table">
          <thead><tr><th>Domain</th><th>Covered objects</th><th>Expected objects</th><th>Coverage</th></tr></thead>
          <tbody>${domainRows.map(([domain, value]) => `<tr><td><strong>${escapeHtml(domain)}</strong><span>${escapeHtml(BATCH_TITLES[domain] || domain)}</span></td><td>${value.covered_items}</td><td>${value.total_items}</td><td>${value.completeness}%</td></tr>`).join('')}</tbody>
        </table>` : ''}
        ${quality.extraction.sources.length > 0 ? `
        <table class="source-packet-table">
          <thead><tr><th>Source extraction</th><th>Processed</th><th>Completeness</th><th>Warnings</th></tr></thead>
          <tbody>${quality.extraction.sources.map(source => `<tr><td><strong>${escapeHtml(source.source_id)}</strong><span>${escapeHtml(source.kind)}</span></td><td>${source.processed_units}/${source.total_units} ${escapeHtml(source.unit)}(s)</td><td>${source.completeness}% · ${source.status}</td><td>${source.warning_count}${source.warning_codes.length > 0 ? ` · ${source.warning_codes.map(code => escapeHtml(code)).join(', ')}` : ''}</td></tr>`).join('')}</tbody>
        </table>` : ''}
      </div>
      ${blockingReasons.length > 0 ? `<div class="gate-label">Readiness blocking reasons</div><ul class="source-packet-notes">${blockingReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    </div>
  </section>`;
};

const renderRunTraceAppendix = (result: DiagnosticResult): string => {
  const trace = result.meta.run_trace;
  const summary = result.meta.run_trace_summary;
  if (!trace || !summary) return '';
  return `
  <h2>RunTrace Provenance</h2>
  <div class="appendix-card">
    <p class="appendix-note">RunTrace is a client-side provenance artifact. It records source/chunk references, hashes, model-stage metadata, evidence paths, score paths, tactic paths, and Quality Gate decisions without embedding full raw source documents or full prompts.</p>
    <div class="evidence-check-grid">
      <div class="evidence-check-stat"><span>Run ID</span><strong style="font-size:0.95rem">${escapeHtml(trace.run_id)}</strong></div>
      <div class="evidence-check-stat"><span>Sources</span><strong>${summary.source_count}</strong></div>
      <div class="evidence-check-stat"><span>Chunks</span><strong>${summary.chunk_count}</strong></div>
      <div class="evidence-check-stat"><span>Model Stages</span><strong>${summary.stage_count}</strong></div>
      <div class="evidence-check-stat"><span>Evidence Paths</span><strong>${summary.evidence_path_count}</strong></div>
      <div class="evidence-check-stat"><span>Score Paths</span><strong>${summary.score_path_count}</strong></div>
      <div class="evidence-check-stat"><span>Tactic Paths</span><strong>${summary.tactic_path_count}</strong></div>
      <div class="evidence-check-stat"><span>Derived Evidence</span><strong>${trace.derived_analytical_evidence?.length || 0}</strong></div>
      <div class="evidence-check-stat"><span>Signal Analyzers</span><strong>${trace.data_signal_coverage?.analyzer_available_count || 0}/${trace.data_signal_coverage?.total_object_count || 60}</strong></div>
      <div class="evidence-check-stat"><span>Retrieval Passes</span><strong>${trace.bounded_retrieval?.domains.reduce((sum, domain) => sum + domain.passes.length, 0) || 0}</strong></div>
      <div class="evidence-check-stat"><span>DLP Chunks</span><strong>${trace.dlp.scanned_chunk_count}</strong></div>
      <div class="evidence-check-stat"><span>Gate</span><strong>${escapeHtml(summary.quality_gate_decision)}</strong></div>
    </div>
    <div class="gate-label">Trace boundaries</div>
    <ul class="appendix-list">
      <li><strong>Raw source included:</strong> ${String(trace.privacy.raw_source_included)}</li>
      <li><strong>Full prompts included:</strong> ${String(trace.privacy.full_prompts_included)}</li>
      <li><strong>API keys included:</strong> ${String(trace.privacy.api_keys_included)}</li>
      <li>${escapeHtml(trace.privacy.note)}</li>
    </ul>
    ${(trace.derived_analytical_evidence || []).length > 0 ? `<div class="gate-label">Shadow deterministic A1/AP-A1 observations</div>
    <ul class="appendix-list">${trace.derived_analytical_evidence!.map(evidence => `<li><strong>${escapeHtml(evidence.evidence_id)}</strong> · ${escapeHtml(evidence.result.status)} · ${evidence.result.row_scope === 'bounded_prefix' ? 'bounded-prefix' : 'full-table'} analyzed-row coverage (${evidence.result.analyzed_row_count}/${evidence.result.source_row_count} rows; input truncated: ${String(evidence.result.row_truncated)}): mapping ${evidence.result.mapping_population_coverage ?? 'n/a'}% · tagging ${evidence.result.tagging_population_coverage ?? 'n/a'}% · allocation ${evidence.result.allocation_population_coverage ?? 'n/a'}% · analyzer ${escapeHtml(evidence.derivation.analyzer_version)} · raw values exposed: ${String(evidence.raw_value_exposure)}</li>`).join('')}</ul>` : ''}
    ${trace.bounded_retrieval ? `<div class="gate-label">Shadow bounded retrieval diagnostics</div><p class="appendix-note">Candidate inclusion measures how much of the eligible routed candidate set was selected. It is not a measure of evidence sufficiency; a domain can include 100% of routed candidates and still have weak evidence.</p><ul class="appendix-list">${trace.bounded_retrieval.domains.map(domain => `<li><strong>Domain ${escapeHtml(domain.domain_id)}</strong> · routed candidate inclusion ${domain.baseline_coverage}%→${domain.final_coverage}% · evidence sufficiency ${result.meta.run_trace?.context_packets.find(packet => packet.domain_id === domain.domain_id)?.weak_coverage ? 'weak' : 'sufficient'} · passes ${domain.passes.length}/${trace.bounded_retrieval!.max_passes} · stop ${escapeHtml(domain.stop_reason)}</li>`).join('')}</ul>` : ''}
    ${trace.data_signal_coverage ? `<div class="gate-label">Data Signal Registry coverage</div><p class="appendix-note">${trace.data_signal_coverage.analyzer_available_count} of ${trace.data_signal_coverage.total_object_count} objects have an authoritative shadow analyzer mapping; ${trace.data_signal_coverage.unsupported_count} remain explicitly NO_AUTHORITATIVE_ANALYZER_SEMANTICS pending governed KB schema definitions.</p>` : ''}
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
          <strong>${escapeHtml(a.stream)}.${escapeHtml(a.id)}</strong> · ${a.verification_unresolved ? `scanner candidate ${a.original_count} · excluded from score` : `${a.original_count}→${a.verified_count}`} · ${escapeHtml(a.status)}${a.rescan_attempted ? ' · rescanned' : ''}
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
        <span class="badge ${item?.assessment_status === 'not_assessed' ? statusBadgeClass('') : stream === 'antipattern' ? antiPatternBadgeClass(item) : statusBadgeClass(item?.status ?? '')}">${escapeHtml(item?.assessment_status === 'not_assessed' ? 'Not Assessed' : stream === 'antipattern' ? antiPatternStatusLabel(item) : `${item?.count ?? 0}/3`)}</span>
      </div>
      <p class="forensic-desc">${escapeHtml(cat.desc)}</p>
      ${stream === 'antipattern' && item?.coverage_reason ? `<div class="gate-rationale">${escapeHtml(item.coverage_reason)}</div>` : ''}
      ${item?.evidence_check_status ? `
      <div class="forensic-block">
        <span class="evidence-check-badge ${evidenceCheckClass(item.evidence_check_status)}">Evidence-check: ${escapeHtml(item.evidence_check_status)}</span>
        ${item.assessment_status === 'not_assessed' ? `<div class="gate-rationale">UNKNOWN · no criterion-relevant evidence available for scoring${item.rescan_attempted ? ' · targeted rescan attempted' : ''}</div>` : item.original_count !== undefined && typeof item.verified_count === 'number' ? `<div class="gate-rationale">score ${item.original_count}/3→${item.verified_count}/3${item.rescan_attempted ? ' · targeted rescan' : ''}</div>` : item.verification_unresolved ? `<div class="gate-rationale">scanner candidate ${item.original_count ?? item.count}/3 · verification unavailable · excluded from score</div>` : ''}
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

const downloadHtml = (html: string, filename: string) => {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const downloadJson = (payload: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const cloneResult = (result: DiagnosticResult): DiagnosticResult =>
  typeof structuredClone === 'function'
    ? structuredClone(result)
    : JSON.parse(JSON.stringify(result));

const resultWithoutRunTrace = (result: DiagnosticResult): DiagnosticResult => {
  const next = cloneResult(result);
  if (next.meta) delete next.meta.run_trace;
  return next;
};

export const downloadMasterDataReport = (result: DiagnosticResult) => {
  downloadHtml(
    generateReportHtml(result),
    `FinOps_Master_Data_${new Date().toISOString().split('T')[0]}.html`
  );
};

export const downloadSummaryReport = (result: DiagnosticResult) => {
  downloadHtml(
    generateSummaryReportHtml(result),
    `FinOps_Summary_Report_${new Date().toISOString().split('T')[0]}.html`
  );
};

export const downloadRunTraceJson = (result: DiagnosticResult) => {
  const trace = stripSourceFilenameMetadata(result).meta.run_trace;
  downloadJson(
    trace || { available: false, reason: 'RunTrace was not present on this assessment result.' },
    `FinOps_RunTrace_${new Date().toISOString().split('T')[0]}.json`
  );
};

export const downloadReport = downloadMasterDataReport;

const renderActionability = (result: DiagnosticResult): string => {
  const vm = buildReportViewModel(result);
  const tone = vm.actionability.gate.toLowerCase();
  return `
    <section class="actionability actionability-${escapeHtml(tone)}">
      <div class="actionability-primary">
        <span>Actionability</span>
        <strong>${escapeHtml(vm.actionability.gate)}</strong>
      </div>
      <p>${escapeHtml(vm.actionability.statement)}</p>
      <div class="actionability-facts">
        <span><strong>${escapeHtml(vm.actionability.planningDecision.replace('_', ' '))}</strong> planning decision</span>
        <span><strong>${escapeHtml(vm.actionability.confidence)}</strong> confidence</span>
        <span><strong>${vm.actionability.blockerCount}</strong> blocking condition${vm.actionability.blockerCount === 1 ? '' : 's'}</span>
      </div>
    </section>`;
};

const renderScoreEvidenceGaps = (result: DiagnosticResult, limit?: number): string => {
  const gaps = result.phase_2_validation.score_evidence_gaps || [];
  if (gaps.length === 0) return '';
  const visible = typeof limit === 'number' ? gaps.slice(0, limit) : gaps;
  const remainder = gaps.length - visible.length;
  return `
    <section class="summary-section">
      <h2>Evidence needed to interpret maturity</h2>
      <div class="summary-card">
        <p>These criteria contribute zero because they were not demonstrated by the supplied material. They are follow-up questions, not proof that capabilities are absent or anti-patterns are present.</p>
        <ul>${visible.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>
        ${remainder > 0 ? `<p><strong>${remainder} additional evidence question${remainder === 1 ? '' : 's'}</strong> remain in the Master Data report.</p>` : ''}
      </div>
    </section>`;
};

const renderEvidenceBackedFindings = (result: DiagnosticResult): string => {
  const evidence = result.phase_3_strategy.evidence_summary;
  if (!evidence) return '';
  const m = result.phase_2_validation.metrics;
  const useSourceObservationTitle = isInsufficientEvidenceReport(
    evidence.maturity_classification,
    m.evidence_density,
    result.quality_gate.decision
  );
  const list = (title: string, items?: string[]) => items && items.length > 0
    ? `<div class="summary-sub"><h3>${escapeHtml(title)}</h3><ul>${items.map(i => `<li>${renderInlineMarkdownHtml(i)}</li>`).join('')}</ul></div>`
    : '';
  const testedAbsences: string[] = [];
  const notAssessed: string[] = [];
  for (const criterion of MASTER_BINGO_FINOPS.antipattern) {
    const item = result.phase_1_audit_logs.antipattern[criterion.id];
    const status = inferAntiPatternAbsenceStatus(item);
    const rationale = item?.coverage_reason || item?.reasoning || 'Source coverage was insufficient to verify absence.';
    if (status === 'tested_absent') testedAbsences.push(`[${criterion.id}] Tested absent: ${rationale}`);
    if (status === 'unknown_absent') notAssessed.push(`[${criterion.id}] Not assessed: ${rationale}`);
  }
  return `
    <section class="evidence-findings">
      <p class="persona-heading">Fact-only current state · ${escapeHtml(evidence.maturity_classification)}</p>
      <h3>${escapeHtml(evidence.headline)}</h3>
      <div class="summary-grid">
        ${list(strengthsSectionTitle(useSourceObservationTitle), evidence.confirmed_strengths)}
        ${list('Confirmed gaps', evidence.confirmed_gaps)}
        ${list('Confirmed anti-patterns', evidence.confirmed_antipatterns)}
        ${list('Tested anti-pattern absences', testedAbsences)}
        ${list('Anti-patterns not assessed', notAssessed)}
        ${list('Silent / missing evidence', evidence.silent_or_missing_evidence)}
      </div>
    </section>`;
};

const renderCanonicalDomainDiagnosis = (result: DiagnosticResult): string =>
  computeDomainSignalRows(result).map(row => `
    <li>
      <strong>${escapeHtml(row.domain)} · ${escapeHtml(row.title)}:</strong>
      Evidence coverage ${row.evidencePercent}%; observed maturity ${row.maturityAvailable ? `${row.maturityPercent}%` : 'unresolved'}; anti-pattern finding rate ${row.antiPatternAvailable ? `${row.antiPatternPercent}%` : 'unresolved'}.
      ${row.antiPatternNotAssessed > 0 ? `${row.antiPatternNotAssessed} anti-pattern criterion${row.antiPatternNotAssessed === 1 ? ' was' : ' were'} not assessed.` : ''}
    </li>`).join('');

const renderSummaryDiagnosis = (result: DiagnosticResult): string => {
  const diagnosis = result.phase_3_strategy.diagnosis;
  if (!diagnosis) return '';
  return `
    <section class="summary-section">
      <h2>Diagnosis</h2>
      <div class="summary-card">
        ${diagnosis.primary_bottleneck ? `<div class="diagnosis-lead"><span>Primary bottleneck</span><p>${escapeHtml(diagnosis.primary_bottleneck)}</p></div>` : ''}
        <div class="two-col">
          <div>
            <h3>Root causes</h3>
            <ul>${(diagnosis.root_causes || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
          </div>
          <div>
            <h3>Domain diagnosis</h3>
            <ul>${renderCanonicalDomainDiagnosis(result)}</ul>
          </div>
        </div>
        <div class="confidence-line"><strong>Diagnostic confidence: ${escapeHtml(diagnosis.confidence || 'unknown')}</strong>${diagnosis.confidence_rationale ? ` · ${escapeHtml(diagnosis.confidence_rationale)}` : ''}</div>
      </div>
    </section>`;
};

const renderSummaryPlanningDecision = (result: DiagnosticResult): string => {
  const decision = result.phase_3_strategy.planning_decision;
  if (!decision) return '';
  const rationale = displayPlanningDecisionRationale(
    decision.rationale || '',
    result.quality_gate.decision,
    result.quality_gate.evidence_check?.failed
  );
  return `
    <section class="summary-section">
      <h2>Planning Decision</h2>
      <div class="decision-card decision-${String(decision.decision || '').toLowerCase()}">
        <div>
          <span>Decision</span>
          <strong>${escapeHtml(String(decision.decision || '').replace('_', ' '))}</strong>
        </div>
        <p>${escapeHtml(rationale)}</p>
        <div class="two-col">
          <div>
            <h3>Safe to act on</h3>
            <ul>${(decision.safe_to_act_on || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
          </div>
          <div>
            <h3>Evidence needed before action</h3>
            <ul>${(decision.evidence_needed_before_action || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
          </div>
        </div>
      </div>
    </section>`;
};

const renderSummaryRoadmap = (result: DiagnosticResult): string => {
  const effectiveBracket = result.phase_3_strategy.effective_bracket ?? result.phase_3_strategy.confidence_bracket;
  const isBlocked = result.quality_gate.decision === 'BLOCK';
  const roadmap = result.phase_3_strategy.remediation_roadmap || [];
  if (effectiveBracket === 'LOW' && result.phase_3_strategy.findings_mode) return renderFindingsMode(result);
  if (effectiveBracket === 'LOW' || isBlocked || roadmap.length === 0) {
    return `
      <section class="summary-section">
        <h2>Remediation Roadmap</h2>
        <div class="withheld-card">
          <strong>Directive roadmap withheld</strong>
          <p>Use the evidence summary, diagnosis, planning decision, and validation plan before acting. The engine withheld implementation actions because the effective confidence level or Quality Gate does not support a directive roadmap.</p>
        </div>
      </section>`;
  }
  return `
    <section class="summary-section">
      <h2>Remediation Roadmap</h2>
      <div class="roadmap-list">
        ${roadmap.map((step, index) => `
          <article class="roadmap-phase summary-roadmap-phase">
            <div class="phase-kicker">Phase ${index + 1}</div>
            <h3>${escapeHtml(step.phase)}</h3>
            <div class="roadmap-context">
              ${step.why ? `<div><span>Why</span><p>${escapeHtml(step.why)}</p></div>` : ''}
              ${step.what ? `<div><span>What</span><p>${escapeHtml(step.what)}</p></div>` : ''}
            </div>
            <div class="how-list">
              <span>How</span>
              <ul>${step.actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
            </div>
          </article>`).join('')}
      </div>
    </section>`;
};

const maturityHeatClass = (item: AuditItem | undefined): string => {
  if (!item || item.is_silent) return 'heat-silent';
  const status = (item.status || '').toUpperCase();
  if (status === 'OK') return 'heat-good';
  if (status === 'PARTIAL') return 'heat-partial';
  return 'heat-gap';
};

const maturityHeatLabel = (item: AuditItem | undefined): string => {
  if (!item || item.is_silent) return 'Silent';
  const status = (item.status || '').toUpperCase();
  if (status === 'OK') return 'OK';
  if (status === 'PARTIAL') return 'Partial';
  return 'Gap';
};

const antiPatternHeatClass = (item: AuditItem | undefined): string => {
  if (!item || item.is_silent) return 'heat-silent';
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'confirmed_present') return 'heat-gap';
  if (status === 'partially_present') return 'heat-partial';
  if (status === 'tested_absent') return 'heat-tested-absent';
  return 'heat-silent';
};

const renderHeatmapCells = (
  stream: 'maturity' | 'antipattern',
  logs: Record<string, AuditItem>,
  compact = false
): string => BATCHES.map(batch => {
  const items = MASTER_BINGO_FINOPS[stream].filter(c => c.batch === batch);
  return `
    <div class="${compact ? 'compact-heatmap-row' : 'heatmap-row'}">
      <div class="${compact ? 'compact-heatmap-batch' : 'heatmap-batch'}"><strong>${batch}</strong><span>${escapeHtml(BATCH_TITLES[batch])}</span></div>
      <div class="${compact ? 'compact-heatmap-cells' : 'heatmap-cells'}">
        ${items.map(cat => {
          const item = logs[cat.id];
          const klass = stream === 'maturity' ? maturityHeatClass(item) : antiPatternHeatClass(item);
          const label = stream === 'maturity' ? maturityHeatLabel(item) : antiPatternStatusLabel(item);
          const score = item?.count ?? 0;
          if (compact) {
            return `
              <article class="compact-heat-cell ${klass}" title="${escapeHtml(`${cat.id} · ${cat.title} · ${label} · score ${score}`)}">
                <div class="compact-heat-head">
                  <strong>${escapeHtml(cat.id)}</strong>
                  <span>${escapeHtml(label)}</span>
                </div>
                <h4>${escapeHtml(cat.title)}</h4>
                <p>${escapeHtml(cat.desc)}</p>
              </article>`;
          }
          return `<div class="heat-cell ${klass}" title="${escapeHtml(`${cat.id} · ${cat.title} · ${label} · score ${score}`)}"><strong>${escapeHtml(cat.id)}</strong><span>${escapeHtml(label)}</span></div>`;
        }).join('')}
      </div>
    </div>`;
}).join('');

const renderAssessmentHeatmapSummary = (result: DiagnosticResult): string => `
  <section class="summary-section">
    <h2>Assessment Heatmap Summary</h2>
    <p class="section-lead">Criterion-level view of what the source material supported, partially supported, contradicted, or could not assess.</p>
    <div class="heatmap-explainer">
      <div><strong>Tested absent</strong><span>Relevant evidence was reviewed and the anti-pattern was not found.</span></div>
      <div><strong>Not assessed</strong><span>Source coverage was too weak or irrelevant, so absence is not positive evidence.</span></div>
    </div>
    <div class="heatmap-legend heatmap-legend-split">
      <span><i class="heat-good"></i> OK</span>
      <span><i class="heat-partial"></i> Partial / partial finding</span>
      <span><i class="heat-gap"></i> Gap / finding</span>
      <span><i class="heat-tested-absent"></i> Tested absent</span>
      <span><i class="heat-silent"></i> Silent / not assessed</span>
    </div>
    <div class="compact-heatmap-grid">
      <div class="compact-heatmap-panel">
        <h3>Maturity coverage</h3>
        ${renderHeatmapCells('maturity', result.phase_1_audit_logs.maturity, true)}
      </div>
      <div class="compact-heatmap-panel">
        <h3>Anti-pattern semantics</h3>
        ${renderHeatmapCells('antipattern', result.phase_1_audit_logs.antipattern, true)}
      </div>
    </div>
  </section>`;

const signalToneClass = (tone: DomainSignalTone): string => `signal-${tone}`;

const renderDomainSignalOverview = (result: DiagnosticResult): string => {
  const rows = computeDomainSignalRows(result);
  if (rows.length === 0) return '';
  return `
  <section class="domain-signal-section">
    <h2>Domain Signal Overview</h2>
    <p class="section-lead">Maturity target is high; anti-pattern finding rate target is low. Grey means the source did not provide enough assessable coverage.</p>
    <div class="domain-signal-grid">
      ${rows.map(row => `
        <article class="domain-signal-card">
          <div class="domain-signal-head">
            <div>
              <span class="domain-signal-id">${escapeHtml(row.domain)}</span>
              <h3>${escapeHtml(row.title)}</h3>
            </div>
            ${row.coverageNote ? `<span class="domain-signal-chip">Coverage note</span>` : ''}
          </div>
          <div class="domain-signal-metrics">
            <div class="domain-signal-metric">
              <div class="signal-label"><i class="${row.evidencePercent >= 60 ? 'signal-green' : row.evidencePercent >= 30 ? 'signal-yellow' : 'signal-grey'}"></i><span>Evidence coverage</span></div>
              <strong>${row.evidencePercent}%</strong>
              <p>Assessed criterion surface</p>
            </div>
            <div class="domain-signal-metric">
              <div class="signal-label"><i class="${signalToneClass(row.maturityTone)}"></i><span>Maturity signal</span></div>
              <strong class="${signalToneClass(row.maturityTone)}">${row.maturityAvailable ? `${row.maturityPercent}%` : row.verificationUnresolved ? 'Unresolved' : 'Not assessed'}</strong>
              <p>${row.maturityAssessed}/${row.maturityTotal} criteria assessed</p>
            </div>
            <div class="domain-signal-metric">
              <div class="signal-label"><i class="${signalToneClass(row.antiPatternTone)}"></i><span>Anti-pattern finding rate</span></div>
              <strong class="${signalToneClass(row.antiPatternTone)}">${row.antiPatternAvailable ? `${row.antiPatternPercent}%` : row.verificationUnresolved ? 'Unresolved' : 'Not assessed'}</strong>
              <p>${row.antiPatternFindings} finding${row.antiPatternFindings === 1 ? '' : 's'}, ${row.antiPatternPartialFindings} partial, ${row.antiPatternNotAssessed} not assessed</p>
            </div>
          </div>
          ${row.coverageNote ? `<p class="domain-signal-note">${escapeHtml(row.coverageNote)}</p>` : ''}
        </article>`).join('')}
    </div>
  </section>`;
};

export const generateSummaryReportHtml = (unsafeResult: DiagnosticResult): string => {
  const result = stripSourceFilenameMetadata(unsafeResult);
  const m = result.phase_2_validation.metrics;
  const reportView = buildReportViewModel(result);
  const summaryPayload = resultWithoutRunTrace(result);
  const cwrClass = result.phase_2_validation.crawl_walk_run;
  const gauges = reportView.metrics;
  const qgTone = result.quality_gate.decision === 'GO' ? 'go' : result.quality_gate.decision === 'WARN' ? 'warn' : 'block';
  const kbStatus = result.meta.knowledge_base
    ? result.meta.knowledge_base.source === 'remote_blob'
      ? `Remote KB ${result.meta.knowledge_base.document_count} PDFs`
      : 'Built-in KB fallback'
    : '';
  const sourceNote = (result.meta.source_parse_warnings?.length ?? 0) > 0
    ? `<p class="source-note">Source coverage note: ${escapeHtml(displaySourceCoverageWarning(result.meta.source_parse_warnings![0]))}${result.meta.source_parse_warnings!.length > 1 ? ` (+${result.meta.source_parse_warnings!.length - 1} more)` : ''}</p>`
    : '';
  const traceNote = result.meta.run_trace_summary
    ? `<p class="trace-note">RunTrace available in the Master Data report and as a separate JSON download: ${result.meta.run_trace_summary.stage_count} model stage(s), ${result.meta.run_trace_summary.evidence_path_count} evidence path(s), ${result.meta.run_trace_summary.score_path_count} score path(s).</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinOps Summary Report</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; line-height: 1.55; }
    .page { max-width: 1120px; margin: 0 auto; padding: 48px 28px 64px; }
    .hero { background: #0f172a; color: #fff; border-radius: 24px; padding: 36px; margin-bottom: 28px; }
    .hero h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 4.25rem); letter-spacing: -0.04em; line-height: 0.95; }
    .hero p { color: #cbd5e1; margin: 0; max-width: 760px; }
    .hero-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); font-size: 0.82rem; font-weight: 700; color: #e2e8f0; }
    .pill-block { color: #fecdd3; }
    .pill-warn { color: #fde68a; }
    .pill-go { color: #bbf7d0; }
    h2 { font-size: 1.55rem; margin: 2.5rem 0 1rem; letter-spacing: -0.02em; }
    h3 { margin: 0 0 0.55rem; font-size: 1rem; }
    ul { margin: 0; padding-left: 1.2rem; }
    li { margin: 0.35rem 0; }
    .summary-section { margin: 28px 0; }
    .section-lead { margin-top: -0.5rem; color: #64748b; }
    .actionability { display: grid; grid-template-columns: minmax(160px, 0.35fr) 1fr; gap: 18px 28px; align-items: center; background: #fff; border: 1px solid #e2e8f0; border-left: 5px solid #94a3b8; border-radius: 16px; padding: 22px; margin: 28px 0; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .actionability-go { border-left-color: #10b981; }
    .actionability-warn { border-left-color: #f59e0b; }
    .actionability-block { border-left-color: #f43f5e; }
    .actionability-primary span { display: block; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem; font-weight: 800; }
    .actionability-primary strong { display: block; font-size: 2.4rem; line-height: 1; margin-top: 5px; }
    .actionability p { margin: 0; color: #334155; }
    .actionability-facts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
    .actionability-facts span { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px; padding: 6px 10px; color: #64748b; font-size: 0.76rem; }
    .evidence-findings { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 22px; margin: 20px 0; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .source-note { margin: 16px 0 0; color: #fcd34d; font-size: 0.85rem; }
    .summary-card, .exec-lens, .decision-card, .withheld-card, .heatmap-panel, .chart-card, .summary-roadmap-phase { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 22px; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
    .summary-sub h3 { color: #047857; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.72rem; margin-bottom: 0.5rem; }
    .summary-sub li { color: #334155; }
    .cg-lead { color: #64748b; margin-top: 0; }
    .exec-grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
    .exec-lens h3 { color: #047857; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.78rem; }
    .summary-prose p, .summary-paragraph { margin: 0 0 1rem; color: #334155; text-align: left; }
    .summary-prose p:last-child, .summary-paragraph:last-child { margin-bottom: 0; }
    .summary-prose strong { color: #0f172a; }
    .summary-prose em { color: #047857; font-style: normal; font-weight: 700; }
    .gauge-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1.25rem; align-items: stretch; }
    .gauge-grid > .gauge-large { grid-column: span 1; }
    .gauge-denominator { color: #334155; font-size: 0.76rem; font-weight: 700; margin-top: 8px; }
    .metric-method-note { margin: 14px 0 0; padding: 14px 16px; background: #f1f5f9; border-left: 4px solid #059669; border-radius: 10px; color: #475569; font-size: 0.86rem; }
    .chart-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
    .chart-desc { color: #64748b; font-size: 0.88rem; margin: 0 0 12px; }
    .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
    .domain-signal-section { margin: 28px 0; }
    .domain-signal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .domain-signal-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 18px; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .domain-signal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .domain-signal-id { display: block; color: #94a3b8; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.75rem; font-weight: 800; }
    .domain-signal-chip { border-radius: 999px; background: #f1f5f9; color: #64748b; padding: 4px 8px; font-size: 0.62rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .domain-signal-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .domain-signal-metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; }
    .signal-label { display: flex; align-items: center; gap: 7px; color: #64748b; font-size: 0.68rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; }
    .signal-label i { width: 11px; height: 11px; border-radius: 999px; display: inline-block; }
    .domain-signal-metric strong { display: block; font-size: 1.75rem; line-height: 1; margin-top: 9px; }
    .domain-signal-metric p, .domain-signal-note { margin: 6px 0 0; color: #64748b; font-size: 0.78rem; }
    .signal-green { color: #047857; }
    .signal-yellow { color: #b45309; }
    .signal-red { color: #be123c; }
    .signal-grey { color: #64748b; }
    .signal-label i.signal-green { background: #10b981; }
    .signal-label i.signal-yellow { background: #f59e0b; }
    .signal-label i.signal-red { background: #f43f5e; }
    .signal-label i.signal-grey { background: #cbd5e1; }
    .diagnosis-lead { border-left: 3px solid #10b981; padding-left: 14px; margin-bottom: 18px; }
    .diagnosis-lead span, .decision-card span, .roadmap-context span, .how-list span, .phase-kicker { display: block; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem; font-weight: 800; }
    .diagnosis-lead p { margin: 4px 0 0; color: #334155; }
    .confidence-line { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e2e8f0; color: #475569; font-size: 0.9rem; }
    .decision-card { border-left: 4px solid #94a3b8; }
    .decision-go, .decision-conditional_go { border-left-color: #10b981; }
    .decision-no_go { border-left-color: #f43f5e; }
    .decision-card > div:first-child strong { display: block; font-size: 1.8rem; letter-spacing: -0.03em; }
    .roadmap-list { display: grid; gap: 18px; }
    .summary-roadmap-phase { border-left: 4px solid #10b981; }
    .summary-roadmap-phase h3 { font-size: 1.2rem; }
    .roadmap-context { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 14px 0; }
    .roadmap-context div { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    .roadmap-context p, .how-list p { margin: 4px 0 0; color: #334155; }
    .how-list { margin-top: 12px; }
    .withheld-card { border-left: 4px solid #f43f5e; }
    .withheld-card p { color: #475569; margin-bottom: 0; }
    .heatmap-explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 14px 0 16px; }
    .heatmap-explainer div { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px; }
    .heatmap-explainer strong { display: block; color: #0f172a; }
    .heatmap-explainer span { display: block; color: #64748b; font-size: 0.86rem; margin-top: 3px; }
    .heatmap-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 16px; color: #475569; font-size: 0.82rem; }
    .heatmap-legend-split { margin-bottom: 18px; }
    .heatmap-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 4px; margin-right: 5px; vertical-align: -1px; }
    .compact-heatmap-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    .compact-heatmap-panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 18px; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .compact-heatmap-panel h3 { margin-bottom: 12px; }
    .compact-heatmap-row { display: grid; grid-template-columns: 150px 1fr; gap: 10px; align-items: stretch; padding: 8px 0; border-top: 1px solid #eef2f7; }
    .compact-heatmap-row:first-of-type { border-top: 0; }
    .compact-heatmap-batch strong { display: block; font-size: 1rem; }
    .compact-heatmap-batch span { color: #64748b; font-size: 0.74rem; }
    .compact-heatmap-cells { display: grid; grid-template-columns: repeat(5, minmax(84px, 1fr)); gap: 7px; }
    .compact-heat-cell { min-height: 172px; border-radius: 12px; padding: 12px; border: 1px solid; }
    .compact-heat-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .compact-heat-head strong { display: block; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.76rem; }
    .compact-heat-head span { display: inline-flex; align-items: center; justify-content: center; min-height: 22px; padding: 3px 7px; border-radius: 999px; background: rgba(255,255,255,0.55); border: 1px solid currentColor; font-size: 0.62rem; font-weight: 900; text-transform: uppercase; }
    .compact-heat-cell h4 { margin: 0 0 8px; color: #0f172a; font-size: 0.88rem; line-height: 1.18; }
    .compact-heat-cell p { margin: 0; color: #334155; font-size: 0.74rem; line-height: 1.38; }
    .heatmap-panel { margin: 16px 0; }
    .heatmap-row { display: grid; grid-template-columns: 170px 1fr; gap: 12px; align-items: stretch; padding: 10px 0; border-top: 1px solid #eef2f7; }
    .heatmap-row:first-of-type { border-top: 0; }
    .heatmap-batch strong { display: block; font-size: 1.1rem; }
    .heatmap-batch span { color: #64748b; font-size: 0.78rem; }
    .heatmap-cells { display: grid; grid-template-columns: repeat(5, minmax(90px, 1fr)); gap: 8px; }
    .heat-cell { min-height: 72px; border-radius: 10px; padding: 10px; border: 1px solid; }
    .heat-cell strong { display: block; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.78rem; }
    .heat-cell span { display: block; margin-top: 8px; font-size: 0.72rem; font-weight: 700; }
    .heat-good { background: #d1fae5; border-color: #a7f3d0; color: #065f46; }
    .heat-tested-absent { background: #ecfdf5; border-color: #86efac; color: #166534; }
    .heat-partial { background: #fef3c7; border-color: #fde68a; color: #92400e; }
    .heat-gap { background: #ffe4e6; border-color: #fecdd3; color: #9f1239; }
    .heat-silent { background: #f1f5f9; border-color: #e2e8f0; color: #64748b; }
    .footer { text-align: center; color: #94a3b8; font-size: 0.85rem; padding: 34px 0 10px; }
    .trace-note { background: #f8fafc; border: 1px solid #e2e8f0; color: #475569; border-radius: 12px; padding: 12px 14px; font-size: 0.85rem; }
    .source-packet-section { margin: 28px 0; }
    .source-packet-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 22px; box-shadow: 0 12px 35px rgba(15,23,42,0.05); }
    .source-packet-note { margin: 0 0 16px; color: #64748b; font-size: 0.92rem; }
    .source-packet-tables { display: grid; gap: 16px; }
    .source-packet-table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; font-size: 0.88rem; }
    .source-packet-table th { background: #f8fafc; color: #475569; text-align: left; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.68rem; }
    .source-packet-table th, .source-packet-table td { border: 1px solid #e2e8f0; padding: 10px 12px; vertical-align: top; }
    .source-packet-table td:first-child span { display: block; color: #64748b; font-size: 0.76rem; margin-top: 2px; }
    .source-packet-metrics-table { max-width: 620px; }
    .source-packet-metrics-table td:last-child { font-weight: 800; color: #0f172a; }
    .packet-coverage { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 3px 8px; font-size: 0.72rem; font-weight: 800; }
    .packet-coverage-ok { background: #d1fae5; color: #065f46; }
    .packet-coverage-weak { background: #fef3c7; color: #92400e; }
    .source-packet-notes { margin: 14px 0 0; padding-left: 1.15rem; color: #475569; font-size: 0.82rem; }
    ${SVG_CSS}
    @media (max-width: 760px) {
      .page { padding: 24px 16px 44px; }
      .hero { padding: 26px; border-radius: 18px; }
      .actionability { grid-template-columns: 1fr; }
      .actionability-facts { grid-column: 1; }
      .gauge-grid { grid-template-columns: 1fr; }
      .gauge-grid > .gauge-large { grid-column: span 1; }
      .compact-heatmap-row { grid-template-columns: 1fr; }
      .compact-heatmap-cells { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .heatmap-row { grid-template-columns: 1fr; }
      .heatmap-cells { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    }
    @media print {
      body { background: #fff; }
      .page { max-width: none; padding: 24px; }
      .summary-card, .exec-lens, .decision-card, .withheld-card, .heatmap-panel, .chart-card, .summary-roadmap-phase, .gauge-card { page-break-inside: avoid; box-shadow: none; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <h1>FinOps Summary Report</h1>
      <p>A shareable view of the validated assessment: executive interpretation, evidence-gated maturity, diagnosis, planning decision, roadmap, and heatmap. Detailed forensic evidence remains in the Master Data report.</p>
      <div class="hero-meta">
        <span class="pill">Generated ${escapeHtml(result.meta.timestamp)}</span>
        <span class="pill pill-${qgTone}">${result.quality_gate.decision === 'BLOCK' ? 'Assessment BLOCKED' : `Maturity band ${escapeHtml(cwrClass)}`}</span>
        ${result.quality_gate.decision === 'BLOCK' ? `<span class="pill">Observed maturity band ${escapeHtml(cwrClass)}</span>` : ''}
        <span class="pill pill-${qgTone}">Quality Gate ${escapeHtml(result.quality_gate.decision)}</span>
        <span class="pill">Evidence ${Math.round(m.evidence_density)}%</span>
        ${kbStatus ? `<span class="pill">${escapeHtml(kbStatus)}</span>` : ''}
      </div>
      ${sourceNote}
    </header>

    ${renderActionability(result)}

    <section class="summary-section">
      <h2>Assessment Metrics</h2>
      <div class="gauge-grid">
        ${gauges.map(g => svgGaugeCard(g)).join('')}
      </div>
      <p class="metric-method-note"><strong>How the maturity score is measured:</strong> ${escapeHtml(MATURITY_SCORE_METHOD_NOTE)}</p>
    </section>

    ${renderDomainSignalOverview(result)}
    ${renderAssessmentHeatmapSummary(result)}
    ${renderSummaryDiagnosis(result)}
    ${renderSummaryPlanningDecision(result)}
    ${renderSummaryRoadmap(result)}
    ${renderSourceRegistryPacketSummary(result)}

    <footer class="footer">
      <p>FinOps Assessment Engine v${escapeHtml(result.meta.engine_version)} · Summary Report</p>
      <p>This report is generated deterministically from the validated assessment output. Full audit details are available in the Master Data report.</p>
      ${traceNote}
    </footer>
  </main>
  <script id="finops-data" type="application/json">${serializeDiagnosticResultForHtml(summaryPayload)}</script>
</body>
</html>`;
};

export const generateReportHtml = (unsafeResult: DiagnosticResult): string => {
  const result = stripSourceFilenameMetadata(unsafeResult);
  const reportView = buildReportViewModel(result);
  const isBlocked = result.quality_gate.decision === 'BLOCK';
  const effectiveBracket = result.phase_3_strategy.effective_bracket ?? result.phase_3_strategy.confidence_bracket;
  const hasFindingsMode = effectiveBracket === 'LOW' && !!result.phase_3_strategy.findings_mode;
  const roadmap = result.phase_3_strategy.remediation_roadmap || [];
  const canRenderRoadmap = effectiveBracket !== 'LOW' && !isBlocked && roadmap.length > 0;
  const gauges = reportView.metrics;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinOps Master Data Report</title>
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
    .gauge-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1.25rem; margin: 1.5rem 0 2rem; align-items: stretch; }
    .gauge-grid > .gauge-large { grid-column: span 1; }
    .gauge-denominator { color: #334155; font-size: 0.76rem; font-weight: 700; margin-top: 0.5rem; }
    .metric-method-note { margin: 0 0 2rem; padding: 0.9rem 1rem; background: #f1f5f9; border-left: 4px solid #059669; border-radius: 0.65rem; color: #475569; font-size: 0.85rem; }
    .actionability { display: grid; grid-template-columns: minmax(160px, 0.35fr) 1fr; gap: 1rem 1.5rem; align-items: center; background: #fff; border: 1px solid #e2e8f0; border-left: 5px solid #94a3b8; border-radius: 1rem; padding: 1.4rem; margin: 1.5rem 0 2rem; }
    .actionability-go { border-left-color: #10b981; }
    .actionability-warn { border-left-color: #f59e0b; }
    .actionability-block { border-left-color: #f43f5e; }
    .actionability-primary span { display: block; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem; font-weight: 800; }
    .actionability-primary strong { display: block; font-size: 2.4rem; line-height: 1; margin-top: 0.3rem; }
    .actionability p { margin: 0; color: #334155; }
    .actionability-facts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .actionability-facts span { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px; padding: 0.35rem 0.65rem; color: #64748b; font-size: 0.75rem; }
    .evidence-findings { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.4rem; margin: 1.25rem 0; }
    .chart-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 1.25rem; }
    .domain-signal-section { margin: 2rem 0; }
    .domain-signal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
    .domain-signal-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.1rem; }
    .domain-signal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.85rem; }
    .domain-signal-id { display: block; color: #94a3b8; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.72rem; font-weight: 800; }
    .domain-signal-chip { border-radius: 999px; background: #f1f5f9; color: #64748b; padding: 0.25rem 0.5rem; font-size: 0.6rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .domain-signal-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.65rem; }
    .domain-signal-metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.75rem; }
    .signal-label { display: flex; align-items: center; gap: 0.45rem; color: #64748b; font-size: 0.65rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; }
    .signal-label i { width: 0.68rem; height: 0.68rem; border-radius: 999px; display: inline-block; }
    .domain-signal-metric strong { display: block; font-size: 1.65rem; line-height: 1; margin-top: 0.55rem; }
    .domain-signal-metric p, .domain-signal-note { margin: 0.4rem 0 0; color: #64748b; font-size: 0.76rem; }
    .signal-green { color: #047857; }
    .signal-yellow { color: #b45309; }
    .signal-red { color: #be123c; }
    .signal-grey { color: #64748b; }
    .signal-label i.signal-green { background: #10b981; }
    .signal-label i.signal-yellow { background: #f59e0b; }
    .signal-label i.signal-red { background: #f43f5e; }
    .signal-label i.signal-grey { background: #cbd5e1; }
    .section-lead { color: #64748b; margin-top: -0.75rem; }
    .heatmap-explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
    .heatmap-explainer div { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.8rem; }
    .heatmap-explainer strong, .heatmap-explainer span { display: block; }
    .heatmap-explainer span { color: #64748b; font-size: 0.8rem; }
    .heatmap-legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0 0 1rem; color: #475569; font-size: 0.78rem; }
    .heatmap-legend i { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 0.2rem; margin-right: 0.3rem; vertical-align: -0.05rem; }
    .compact-heatmap-grid { display: grid; gap: 1rem; }
    .compact-heatmap-panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1rem; }
    .compact-heatmap-row { display: grid; grid-template-columns: 150px 1fr; gap: 0.6rem; padding: 0.5rem 0; border-top: 1px solid #eef2f7; }
    .compact-heatmap-row:first-of-type { border-top: 0; }
    .compact-heatmap-batch strong, .compact-heatmap-batch span { display: block; }
    .compact-heatmap-batch span { color: #64748b; font-size: 0.7rem; }
    .compact-heatmap-cells { display: grid; grid-template-columns: repeat(5, minmax(84px, 1fr)); gap: 0.45rem; }
    .compact-heat-cell { min-height: 150px; border-radius: 0.7rem; padding: 0.7rem; border: 1px solid; }
    .compact-heat-head { display: flex; justify-content: space-between; gap: 0.4rem; margin-bottom: 0.6rem; }
    .compact-heat-head strong { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.72rem; }
    .compact-heat-head span { font-size: 0.58rem; font-weight: 800; text-transform: uppercase; }
    .compact-heat-cell h4 { margin: 0 0 0.4rem; font-size: 0.8rem; line-height: 1.2; }
    .compact-heat-cell p { margin: 0; color: #334155; font-size: 0.68rem; line-height: 1.35; }
    .heat-good { background: #d1fae5; border-color: #a7f3d0; color: #065f46; }
    .heat-tested-absent { background: #ecfdf5; border-color: #86efac; color: #166534; }
    .heat-partial { background: #fef3c7; border-color: #fde68a; color: #92400e; }
    .heat-gap { background: #ffe4e6; border-color: #fecdd3; color: #9f1239; }
    .heat-silent { background: #f1f5f9; border-color: #e2e8f0; color: #64748b; }
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
    .source-packet-section { margin: 2rem 0; }
    .source-packet-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.25rem; }
    .source-packet-note { margin: 0 0 1rem; color: #64748b; font-size: 0.875rem; }
    .source-packet-tables { display: grid; gap: 1rem; }
    .source-packet-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; background: #fff; }
    .source-packet-table th { background: #f1f5f9; color: #475569; text-align: left; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.65rem; }
    .source-packet-table th, .source-packet-table td { border: 1px solid #e2e8f0; padding: 0.65rem 0.75rem; vertical-align: top; }
    .source-packet-table td:first-child span { display: block; color: #64748b; font-size: 0.72rem; margin-top: 0.1rem; }
    .source-packet-metrics-table { max-width: 620px; }
    .source-packet-metrics-table td:last-child { font-weight: 800; color: #0f172a; }
    .packet-coverage { display: inline-flex; align-items: center; min-height: 1.5rem; border-radius: 999px; padding: 0.15rem 0.5rem; font-size: 0.68rem; font-weight: 800; }
    .packet-coverage-ok { background: #d1fae5; color: #065f46; }
    .packet-coverage-weak { background: #fef3c7; color: #92400e; }
    .source-packet-notes { margin: 1rem 0 0; padding-left: 1.15rem; color: #475569; font-size: 0.82rem; }
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
    @media (max-width: 760px) {
      body { padding: 24px 16px; }
      .actionability { grid-template-columns: 1fr; }
      .actionability-facts { grid-column: 1; }
      .gauge-grid { grid-template-columns: 1fr; }
      .compact-heatmap-row { grid-template-columns: 1fr; }
      .compact-heatmap-cells { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    }
    @media print {
      body { padding: 24px; max-width: none; }
      h2 { page-break-after: avoid; }
      .forensic-card, .roadmap-phase, .gauge-card, .chart-card { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>FinOps Master Data</h1>
  <div class="meta">
    <p>Generated ${escapeHtml(result.meta.timestamp)} · Engine ${escapeHtml(result.meta.engine_version)}</p>
    ${result.meta.knowledge_base ? `<p>Knowledge Base: ${result.meta.knowledge_base.source === 'remote_blob'
      ? `Remote PDF KB loaded (${escapeHtml(String(result.meta.knowledge_base.document_count))} PDFs${result.meta.knowledge_base.failure_count ? `, ${escapeHtml(String(result.meta.knowledge_base.failure_count))} issue(s)` : ''})`
      : 'Built-in KB fallback'}</p>` : ''}
    ${(result.meta.source_parse_warnings?.length ?? 0) > 0 ? `<p>Source coverage note: ${escapeHtml(displaySourceCoverageWarning(result.meta.source_parse_warnings![0]))}${result.meta.source_parse_warnings!.length > 1 ? ` (+${result.meta.source_parse_warnings!.length - 1} more)` : ''}</p>` : ''}
  </div>

  ${renderActionability(result)}

  <h2>Assessment Metrics</h2>
  <div class="gauge-grid">
    ${gauges.map(g => svgGaugeCard(g)).join('')}
  </div>
  <p class="metric-method-note"><strong>How the maturity score is measured:</strong> ${escapeHtml(MATURITY_SCORE_METHOD_NOTE)}</p>

  ${renderDomainSignalOverview(result)}
  ${renderAssessmentHeatmapSummary(result)}
  ${renderScoreEvidenceGaps(result)}

  <h2>Evidence-Backed Findings</h2>
  ${renderEvidenceBackedFindings(result)}

  ${(() => {
    const diagnosis = result.phase_3_strategy.diagnosis;
    if (!diagnosis) return '';
    const primaryBottleneck = diagnosis.primary_bottleneck?.trim();
    return `
      <h2>Diagnosis</h2>
      <div class="summary diagnosis">
        <p class="persona-heading">Interpretation of evidence — not the implementation plan</p>
        ${primaryBottleneck ? `<h3>Primary bottleneck</h3><p>${escapeHtml(primaryBottleneck)}</p>` : ''}
        <div class="summary-grid">
          <div class="summary-sub"><h3>Root causes</h3><ul>${(diagnosis.root_causes || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>
          <div class="summary-sub"><h3>Domain diagnosis</h3><ul>${renderCanonicalDomainDiagnosis(result)}</ul></div>
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
    const withMaterial = claims.filter(isReportableSourceCoverageGap);
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

  ${renderEvidenceCheckSummary(result)}
  ${renderForensicSection('Forensic Audit: FinOps Maturity', 'maturity', result.phase_1_audit_logs.maturity)}
  ${renderForensicSection('Forensic Audit: Anti-Patterns', 'antipattern', result.phase_1_audit_logs.antipattern)}
  ${renderQualityGateAppendix(result.quality_gate)}
  ${renderAcquisitionQuality(result)}
  ${renderSourceRegistryPacketSummary(result)}
  ${renderRunTraceAppendix(result)}

  <div class="footer">
    <p>FinOps Assessment Engine v${escapeHtml(result.meta.engine_version)}</p>
  </div>

  <script id="finops-data" type="application/json">${serializeDiagnosticResultForHtml(result)}</script>
</body>
</html>`;
};
