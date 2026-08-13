import React, { useState } from 'react';
import { AuditItem, DiagnosticResult, QualityGateResult, ConfidenceBracket, FindingsModeOutput, RemediationStep } from '../types';
import { MarkdownRenderer } from './DashboardComponents';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { METRIC_DESCRIPTIONS } from '../constants';
import { SVG_CSS, svgGaugeCard, svgRadar, svgScatter } from '../services/svgChartService';
import { isInsufficientEvidenceReport, renderInlineMarkdownHtml, strengthsSectionTitle } from '../services/reportTextService';
import { antiPatternStatusLabel, inferAntiPatternAbsenceStatus } from '../services/antiPatternSemantics';
import { displayQualityGateDiagnostic, isReportableSourceCoverageGap, splitQualityGateDiagnostics } from '../services/reportDiagnosticsService';
import { computeDomainSignalRows, DomainSignalTone } from '../services/domainSignalService';
import { buildReportViewModel } from '../services/reportViewModel';

const InlineSvg: React.FC<{ html: string; className?: string }> = ({ html, className }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
);

const BracketBadge: React.FC<{ synthesis?: ConfidenceBracket; effective?: ConfidenceBracket }> = ({ synthesis, effective }) => {
  if (!effective) return null;
  const downgraded = synthesis && synthesis !== effective;
  const palette: Record<ConfidenceBracket, { ring: string; text: string; label: string }> = {
    HIGH:   { ring: 'ring-emerald-300 bg-emerald-50',  text: 'text-emerald-800', label: 'High Confidence — Directive Roadmap' },
    MEDIUM: { ring: 'ring-amber-300 bg-amber-50',      text: 'text-amber-800',   label: 'Medium Confidence — Cautious Roadmap' },
    LOW:    { ring: 'ring-rose-300 bg-rose-50',        text: 'text-rose-800',    label: 'Low Confidence — Findings Only' },
  };
  const p = palette[effective];
  return (
    <div className={`mb-4 p-3 rounded-xl ring-1 ${p.ring} text-xs flex items-center gap-2`}>
      <span className={`font-bold uppercase tracking-wider ${p.text}`}>{p.label}</span>
      {downgraded && (
        <span className="text-slate-600 italic">
          (synthesized as {synthesis}; downgraded by Quality Gate)
        </span>
      )}
    </div>
  );
};

const FindingsPanel: React.FC<{ findings: FindingsModeOutput }> = ({ findings }) => {
  const Section: React.FC<{ title: string; items: string[]; accent: string }> = ({ title, items, accent }) => {
    if (!items || items.length === 0) return null;
    return (
      <div className="mb-6">
        <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${accent}`}>{title}</h3>
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0"></span>
              <span>{it}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };
  return (
    <div className="mb-12 p-6 bg-rose-50/50 rounded-xl border border-rose-200">
      <h2 className="text-2xl font-display font-bold text-slate-900 mb-2">Findings &amp; Validation Plan</h2>
      <p className="text-sm text-slate-600 mb-6 italic">
        Evidence in the source did not support a directive roadmap. This section reports what the audit can confirm and what additional material is needed before a confident strategy can be written.
      </p>
      <Section title="Evidence-backed findings" items={findings.evidence_backed_findings} accent="text-slate-700" />
      <Section title="Candidate remediation themes" items={findings.candidate_themes} accent="text-slate-700" />
      <Section title="Missing evidence" items={findings.missing_evidence} accent="text-rose-700" />
      <Section title="Validation plan (next assessment cycle)" items={findings.validation_plan} accent="text-emerald-700" />
    </div>
  );
};

const RemediationStepBlock: React.FC<{ step: RemediationStep; index: number }> = ({ step, index }) => {
  const confLabel: Record<NonNullable<RemediationStep['confidence']>, { text: string; chip: string }> = {
    high:   { text: 'High confidence',   chip: 'bg-emerald-100 text-emerald-800' },
    medium: { text: 'Medium confidence', chip: 'bg-amber-100 text-amber-800' },
    low:    { text: 'Low confidence',    chip: 'bg-rose-100 text-rose-800' },
  };
  return (
    <div className="p-6 bg-slate-50 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h3 className="font-bold text-lg text-slate-900">{step.phase}</h3>
        {step.confidence && (
          <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded ${confLabel[step.confidence].chip}`}>
            {confLabel[step.confidence].text}
          </span>
        )}
      </div>
      {(step.why || step.what) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {step.why && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Why</p>
              <p className="text-sm text-slate-700 leading-relaxed">{step.why}</p>
            </div>
          )}
          {step.what && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">What</p>
              <p className="text-sm text-slate-700 leading-relaxed">{step.what}</p>
            </div>
          )}
        </div>
      )}
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">How</p>
      <ul className="space-y-3 mb-4">
        {step.actions.map((action, i) => (
          <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
            <span>{action}</span>
          </li>
        ))}
      </ul>
      {step.assumptions && step.assumptions.length > 0 && (
        <div className="pt-3 border-t border-slate-200">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Assumptions</p>
          <ul className="space-y-1 text-xs text-slate-600">
            {step.assumptions.map((a, i) => (
              <li key={i} className="pl-3 border-l-2 border-slate-300">{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const QualityGateBlock: React.FC<{ gate: QualityGateResult }> = ({ gate }) => {
  const palette = gate.decision === 'GO'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : gate.decision === 'BLOCK'
      ? 'border-rose-200 bg-rose-50 text-rose-900'
      : 'border-amber-200 bg-amber-50 text-amber-900';
  const supported = (() => {
    const fc = gate.fact_check;
    if (!fc) return 'fact-check unavailable';
    if (fc.total_claims > 0) {
      const base = `${fc.supported_count}/${fc.total_claims} claims supported`;
      return fc.partial_failure_reason ? `${base} · partial check` : base;
    }
    return fc.failed ? 'fact-check unavailable' : '0 claims checked';
  })();
  const statusText = gate.decision === 'GO'
    ? gate.notes[0] || 'All checks passed.'
    : gate.decision === 'WARN'
      ? gate.fact_check?.sanitized_claims?.length
        ? 'Assessment score remains valid. Unsupported strategy wording or actions were removed or retained only in the appendix.'
        : 'Assessment score remains valid. WARN-level strategy hygiene notes are included in the appendix for traceability.'
      : 'Assessment is unsafe to act on until blocking issues are resolved.';
  return (
    <div className={`mb-5 p-4 rounded-xl border ${palette} flex flex-col md:flex-row md:items-center md:justify-between gap-3`}>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider">Quality Gate Status: {gate.decision}</p>
        <p className="text-sm mt-1">{statusText}</p>
      </div>
      <span className="text-xs font-bold uppercase tracking-wider">{supported}</span>
    </div>
  );
};

const toneDotClass: Record<DomainSignalTone, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-rose-500',
  grey: 'bg-slate-300'
};

const toneTextClass: Record<DomainSignalTone, string> = {
  green: 'text-emerald-700',
  yellow: 'text-amber-700',
  red: 'text-rose-700',
  grey: 'text-slate-500'
};

const DomainSignalOverview: React.FC<{ result: DiagnosticResult }> = ({ result }) => {
  const rows = computeDomainSignalRows(result);
  if (rows.length === 0) return null;
  return (
    <div className="mb-12">
      <h2 className="text-2xl font-display font-bold text-slate-900 mb-2">Domain Signal Overview</h2>
      <p className="text-sm text-slate-500 mb-5">
        Maturity target is high; anti-pattern finding rate target is low. Grey means the source did not provide enough assessable coverage.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rows.map(row => (
          <div key={row.domain} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <p className="font-mono text-xs font-bold text-slate-400">{row.domain}</p>
                <h3 className="font-display font-bold text-slate-900 leading-tight">{row.title}</h3>
              </div>
              {row.coverageNote && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-slate-500">
                  Coverage note
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${toneDotClass[row.maturityTone]}`}></span>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Maturity signal</span>
                </div>
                <p className={`mt-2 text-3xl font-bold ${toneTextClass[row.maturityTone]}`}>{row.maturityPercent}%</p>
                <p className="text-xs text-slate-500 mt-1">{row.maturityAssessed}/{row.maturityTotal} criteria assessed</p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${toneDotClass[row.antiPatternTone]}`}></span>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Anti-pattern finding rate</span>
                </div>
                <p className={`mt-2 text-3xl font-bold ${toneTextClass[row.antiPatternTone]}`}>{row.antiPatternPercent}%</p>
                <p className="text-xs text-slate-500 mt-1">
                  {row.antiPatternFindings} finding{row.antiPatternFindings === 1 ? '' : 's'}, {row.antiPatternPartialFindings} partial, {row.antiPatternNotAssessed} not assessed
                </p>
              </div>
            </div>
            {row.coverageNote && <p className="mt-3 text-xs text-slate-500">{row.coverageNote}</p>}
          </div>
        ))}
      </div>
    </div>
  );
};

const QualityGateAppendix: React.FC<{ gate: QualityGateResult }> = ({ gate }) => {
  const { primaryWarnings, appendixDiagnostics } = splitQualityGateDiagnostics(gate);
  const hasFactCheckNotes = !!gate.fact_check && !gate.fact_check.failed && gate.fact_check.unsupported_claims.length > 0;
  const hasSanitizedNotes = !!gate.fact_check?.sanitized_claims?.length;
  const hasPartialFactCheck = !!gate.fact_check?.partial_failure_reason;
  if (gate.decision === 'GO' && primaryWarnings.length === 0 && appendixDiagnostics.length === 0 && !hasFactCheckNotes) return null;

  const llm = gate.llm_explanation;
  const evidenceWarnings = primaryWarnings.filter(w => w.startsWith('Evidence-check'));
  const remainingWarnings = primaryWarnings.filter(w => !w.startsWith('Evidence-check'));
  const tacticDiagnostics = appendixDiagnostics.filter(w => w.includes('tactic grounding') || w.includes('no tactic IDs'));
  const strategyDiagnostics = appendixDiagnostics.filter(w => !tacticDiagnostics.includes(w));

  const renderList = (
    title: string,
    items: string[],
    explanations?: { reason: string; explanation: string; quote?: string; source_location?: string }[]
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">{title}</p>
        <ul className="space-y-2.5 text-sm text-slate-700">
          {items.map((item, i) => {
            const ex = explanations?.find((it) => it.reason === item);
            return (
              <li key={i} className="pl-3 border-l-2 border-slate-300">
                <p className="font-medium">{displayQualityGateDiagnostic(item)}</p>
                {ex?.explanation && <p className="text-xs text-slate-500 mt-1">{ex.explanation}</p>}
                {ex?.quote && (
                  <p className="text-xs text-slate-500 italic mt-1">
                    &ldquo;{ex.quote}&rdquo;{ex.source_location ? ` — ${ex.source_location}` : ''}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <div className="mb-12">
      <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">
        Quality &amp; Strategy Hygiene Appendix
      </h2>
      <div className="p-5 bg-slate-50 rounded-xl border border-slate-200">
        <p className="text-sm text-slate-600 mb-5">
          Quality Gate detail is retained here for traceability. WARN-level strategy hygiene notes do not invalidate the assessment score.
        </p>
        {llm?.summary && (
          <div className="mb-5 p-3 bg-white rounded border border-slate-200">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Reviewer Summary</p>
            <p className="text-sm text-slate-700">{llm.summary}</p>
          </div>
        )}
        {renderList('Blocking', gate.blocking_reasons, llm?.blocking_details)}
        {hasSanitizedNotes && (
          <div className="mb-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Sanitized strategy items</p>
            <ul className="space-y-2 text-sm text-slate-700">
              {gate.fact_check!.sanitized_claims!.map((c, i) => (
                <li key={i} className="pl-3 border-l-2 border-slate-300">
                  <span className="font-medium capitalize">{c.action}</span>
                  <span>{c.source_location ? ` · ${c.source_location}` : ''}: </span>
                  <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                  {c.rationale && <span className="block text-xs text-slate-500 mt-0.5">{c.rationale}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {renderList('Evidence-check adjustments', evidenceWarnings, llm?.warning_details)}
        {renderList('Strategy hygiene notes', strategyDiagnostics, llm?.warning_details)}
        {renderList('Tactic grounding notes', tacticDiagnostics, llm?.warning_details)}
        {renderList('Remaining warnings', remainingWarnings, llm?.warning_details)}
        {hasPartialFactCheck && (
          <div className="mb-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Partial fact-check status</p>
            <p className="text-sm text-slate-700 pl-3 border-l-2 border-slate-300">
              {gate.fact_check!.partial_failure_reason}
            </p>
          </div>
        )}
        {gate.fact_check && !gate.fact_check.failed && (gate.fact_check.trajectory?.length ?? 0) > 1 && (
          <div className="mb-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Fact-check trajectory</p>
            <ul className="space-y-1 text-xs text-slate-700 font-mono">
              {gate.fact_check.trajectory!.map((p, i) => {
                const prev = i > 0 ? gate.fact_check!.trajectory![i - 1] : null;
                const overlap = prev
                  ? p.unsupported_signatures.filter(s => prev.unsupported_signatures.some(ps => ps === s)).length
                  : 0;
                return (
                  <li key={p.attempt} className="pl-3 border-l-2 border-slate-300">
                    pass {p.attempt}: {p.supported_count}/{p.total_claims} supported, {p.unsupported_count} unsupported
                    {prev && overlap > 0 && (
                      <span className="text-rose-600"> · {overlap} claims unchanged</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {hasFactCheckNotes && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Remaining fact-check notes</p>
            <ul className="space-y-2 text-sm text-slate-700">
              {gate.fact_check!.unsupported_claims.map((c, i) => (
                <li key={i} className="pl-3 border-l-2 border-slate-300">
                  <span className="font-medium">{c.source_location || 'unknown'}:</span> <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                  {c.rationale && <span className="block text-xs text-slate-500 mt-0.5">{c.rationale}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {llm?.failed && (
          <p className="text-xs text-slate-500 italic mt-5">Reviewer narrative unavailable: {llm.failure_reason}</p>
        )}
      </div>
    </div>
  );
};

const BATCHES = Object.keys(BATCH_TITLES);

const statusBadgeClass = (status: string): string => {
  if (status === 'OK') return 'bg-emerald-100 text-emerald-700';
  if (status === 'NOK') return 'bg-rose-100 text-rose-700';
  if (status === 'Partial') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-500';
};

const evidenceCheckBadgeClass = (status?: AuditItem['evidence_check_status']): string => {
  if (status === 'supported') return 'bg-emerald-100 text-emerald-700';
  if (status === 'weak') return 'bg-amber-100 text-amber-700';
  if (status === 'unsupported') return 'bg-rose-100 text-rose-700';
  if (status === 'missing') return 'bg-slate-100 text-slate-600';
  return 'bg-slate-100 text-slate-500';
};

const antiPatternBadgeClass = (item?: AuditItem): string => {
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'confirmed_present') return 'bg-rose-100 text-rose-700';
  if (status === 'partially_present') return 'bg-amber-100 text-amber-700';
  if (status === 'tested_absent') return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-600';
};

const ForensicCriterion: React.FC<{
  catalog: { id: string; title: string; desc: string };
  item?: AuditItem;
  stream: 'maturity' | 'antipattern';
}> = ({ catalog, item, stream }) => (
  <div className="p-5 bg-white rounded-xl border border-slate-200">
    <div className="flex items-start justify-between gap-4 mb-2">
      <div className="min-w-0">
        <span className="font-mono text-xs text-slate-400">{catalog.id}</span>
        <h4 className="font-bold text-slate-900 leading-snug">{catalog.title}</h4>
      </div>
      <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider shrink-0 ${stream === 'antipattern' ? antiPatternBadgeClass(item) : statusBadgeClass(item?.status ?? '')}`}>
        {stream === 'antipattern' ? antiPatternStatusLabel(item) : (item?.status ?? 'No Data')}
      </span>
    </div>
    {stream === 'antipattern' && item?.coverage_reason && (
      <p className="mb-3 text-xs text-slate-500">{item.coverage_reason}</p>
    )}
    {item?.evidence_check_status && (
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider ${evidenceCheckBadgeClass(item.evidence_check_status)}`}>
          Evidence-check: {item.evidence_check_status}
        </span>
        {item.original_count !== undefined && item.verified_count !== undefined && (
          <span className="text-xs font-mono text-slate-500">
            score {item.original_count}→{item.verified_count}{item.rescan_attempted ? ' · targeted rescan' : ''}
          </span>
        )}
        {item.adjustment_reason && <p className="basis-full text-xs text-slate-500">{item.adjustment_reason}</p>}
      </div>
    )}
    <p className="text-sm text-slate-500 mb-3">{catalog.desc}</p>
    {item?.reasoning && (
      <div className="mb-3">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">AI Reasoning</p>
        <p className="text-sm text-slate-700 whitespace-pre-line">{item.reasoning}</p>
      </div>
    )}
    {item?.category_footprint && Object.keys(item.category_footprint).length > 0 && (
      <div className="mb-3">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Evidence Categories</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(item.category_footprint).map(([cat, n]) => (
            <span key={cat} className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
              {cat} <span className="text-slate-500">×{n}</span>
            </span>
          ))}
        </div>
      </div>
    )}
    {item?.evidence_quotes && item.evidence_quotes.length > 0 && (
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Evidence</p>
        <ul className="space-y-2">
          {item.evidence_quotes.map((q, i) => {
            const isImage = q.evidence_source === 'image';
            return (
              <li key={i} className={`border-l-2 pl-3 text-sm italic ${isImage ? 'border-violet-300 text-violet-900' : 'border-slate-300 text-slate-600'}`}>
                {isImage && (
                  <span title="Image-derived evidence" className="inline-flex items-center justify-center w-4 h-4 mr-1.5 rounded bg-violet-100 text-violet-700 not-italic align-middle">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </span>
                )}
                &ldquo;{q.quote}&rdquo;
                {(q.section || q.category || q.page_number || isImage) && (
                  <span className="text-xs text-slate-400 not-italic">
                    {isImage && <> · visual</>}
                    {q.page_number !== undefined && <> · page {q.page_number}</>}
                    {q.section && <> — {q.section}</>}
                    {q.category && <> · {q.category}</>}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    )}
  </div>
);

const ForensicSection: React.FC<{
  title: string;
  stream: 'maturity' | 'antipattern';
  logs: Record<string, AuditItem>;
  criticalLabel: string;
  criticalHint: string;
}> = ({ title, stream, logs, criticalLabel, criticalHint }) => {
  const [mode, setMode] = useState<'all' | 'critical'>('all');
  const catalog = MASTER_BINGO_FINOPS[stream];
  const totalCount = catalog.length;
  const isCritical = (item?: AuditItem): boolean => stream === 'antipattern'
    ? (item?.count || 0) > 0
    : item?.status === 'NOK';
  const criticalCount = catalog.filter(c => isCritical(logs[c.id])).length;
  const visibleCatalog = mode === 'critical' ? catalog.filter(c => isCritical(logs[c.id])) : catalog;

  const pillBase = 'px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors';
  const pillActive = 'bg-slate-900 text-white';
  const pillIdle = 'bg-slate-100 text-slate-500 hover:bg-slate-200';

  return (
    <div className="mb-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4 pb-3 border-b border-slate-200">
        <h2 className="text-2xl font-display font-bold text-slate-900">
          {title}
          <span className="ml-3 text-sm font-normal text-slate-400">
            {totalCount} criteria · {criticalCount} {criticalHint}
          </span>
        </h2>
        <div className="flex items-center gap-2" role="group" aria-label={`${title} filter`}>
          <button
            type="button"
            onClick={() => setMode('all')}
            className={`${pillBase} ${mode === 'all' ? pillActive : pillIdle}`}
            aria-pressed={mode === 'all'}
          >
            All {totalCount}
          </button>
          <button
            type="button"
            onClick={() => setMode('critical')}
            disabled={criticalCount === 0}
            className={`${pillBase} ${mode === 'critical' ? pillActive : pillIdle} ${criticalCount === 0 ? 'opacity-40 cursor-not-allowed hover:bg-slate-100' : ''}`}
            aria-pressed={mode === 'critical'}
            title={criticalCount === 0 ? `No ${criticalHint} in this stream.` : undefined}
          >
            {criticalLabel} {criticalCount}
          </button>
        </div>
      </div>

      {visibleCatalog.length === 0 ? (
        <div className="p-6 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700">
          No {criticalHint} in this stream — nothing to flag.
        </div>
      ) : (
        <div className="space-y-8">
          {BATCHES.map(batchId => {
            const items = visibleCatalog.filter(c => c.batch === batchId);
            if (items.length === 0) return null;
            return (
              <div key={batchId}>
                <h3 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-3">
                  {batchId} — {BATCH_TITLES[batchId]}
                </h3>
                <div className="space-y-3">
                  {items.map(cat => (
          <ForensicCriterion key={cat.id} catalog={cat} item={logs[cat.id]} stream={stream} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const EvidenceCheckSummaryBlock: React.FC<{ result: DiagnosticResult }> = ({ result }) => {
  const evidenceCheck = result.evidence_check;
  if (!evidenceCheck || evidenceCheck.total_items === 0) return null;
  const stats = [
    ['Supported', evidenceCheck.supported_count, 'text-emerald-700'],
    ['Weak', evidenceCheck.weak_count, 'text-amber-700'],
    ['Unsupported', evidenceCheck.unsupported_count, 'text-rose-700'],
    ['Missing', evidenceCheck.missing_count, 'text-slate-600'],
    ['Downgraded', evidenceCheck.downgraded_count, 'text-rose-700'],
    ['Rescanned', evidenceCheck.rescan_count, 'text-slate-700'],
  ] as const;
  return (
    <div className="mb-8 p-6 rounded-xl border border-slate-200 bg-white">
      <h2 className="text-xl font-display font-bold text-slate-900 mb-2">Evidence Check</h2>
      <QualityGateBlock gate={result.quality_gate} />
      <p className="text-sm text-slate-600 mb-4">
        Phase 1 findings were verified against the raw material before Phase 2 metrics were calculated.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        {stats.map(([label, value, color]) => (
          <div key={label} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>
      {evidenceCheck.adjustments.length > 0 && (
        <ul className="space-y-2 text-sm text-slate-700">
          {evidenceCheck.adjustments.slice(0, 10).map((a, i) => (
            <li key={i} className="pl-3 border-l-2 border-slate-300">
              <span className="font-mono text-xs">{a.stream}.{a.id}</span>
              <span className="text-slate-500"> · {a.original_count}→{a.verified_count} · {a.status}{a.rescan_attempted ? ' · rescanned' : ''}</span>
              {a.reason && <span className="block text-xs text-slate-500 mt-0.5">{a.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface ReportViewProps {
  result: DiagnosticResult;
  onBack: () => void;
  onDownloadSummary: () => void;
  onDownloadMaster: () => void;
  onDownloadTrace: () => void;
}

export const ReportView: React.FC<ReportViewProps> = ({ result, onBack, onDownloadSummary, onDownloadMaster, onDownloadTrace }) => {
  const m = result.phase_2_validation.metrics;
  const reportView = buildReportViewModel(result);
  const cwrClass = result.phase_2_validation.crawl_walk_run;
  const isBlocked = result.quality_gate.decision === 'BLOCK';
  const isInsufficientEvidence = isBlocked || m.evidence_density < 30 || m.antipattern_coverage < 60;
  const readinessDescription = m.readiness_cap_reason || METRIC_DESCRIPTIONS.finops_readiness;
  const gauges = reportView.metrics;

  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans">
      <style>{SVG_CSS}</style>
      <div className="sticky top-0 z-50 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-6 py-4 flex justify-between items-center">
          <button onClick={onBack} className="text-sm font-bold text-slate-500 hover:text-slate-900 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back to Dashboard
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onDownloadSummary} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-bold text-sm hover:bg-emerald-700 transition-colors">
              Download Summary Report
            </button>
            <button onClick={onDownloadMaster} className="px-4 py-2 bg-slate-900 text-white rounded-lg font-bold text-sm hover:bg-slate-700 transition-colors">
              Download Master Data
            </button>
            {result.meta.run_trace && (
              <button onClick={onDownloadTrace} className="px-4 py-2 bg-slate-100 text-slate-900 rounded-lg font-bold text-sm hover:bg-slate-200 transition-colors">
                RunTrace JSON
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-display font-bold text-slate-900 mb-2">FinOps Maturity Assessment</h1>
          <p className="text-slate-500">Generated: {result.meta.timestamp} | Engine: {result.meta.engine_version}</p>
          {(result.meta.source_parse_warnings?.length ?? 0) > 0 && (
            <p className="text-xs text-amber-700 mt-2">
              Source parse note: {result.meta.source_parse_warnings![0]}
              {result.meta.source_parse_warnings!.length > 1 ? ` (+${result.meta.source_parse_warnings!.length - 1} more)` : ''}
            </p>
          )}
        </div>

        <BracketBadge
          synthesis={result.phase_3_strategy.confidence_bracket}
          effective={result.phase_3_strategy.effective_bracket ?? result.phase_3_strategy.confidence_bracket}
        />
        <EvidenceCheckSummaryBlock result={result} />

        <div className="mb-12 p-8 bg-slate-50 rounded-2xl border border-slate-200">
          <div className="flex items-center gap-4 mb-6">
            <span className={`px-4 py-2 rounded-lg font-bold text-sm ${cwrClass.includes('Insufficient') || cwrClass.includes('Crawl') ? 'bg-rose-100 text-rose-700' : cwrClass.includes('Run') ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {cwrClass}
            </span>
            <span className="text-slate-400">|</span>
            <span className="text-sm font-mono text-slate-500">
              Delivery {m.delivery_integrity}% · Evidence {m.evidence_density}%
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Evidence-Gated Readiness</p>
              <p className={`text-3xl font-bold ${isBlocked ? 'text-rose-600' : 'text-emerald-600'}`}>{Math.round(m.finops_readiness)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{readinessDescription}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Maturity Depth</p>
              <p className="text-3xl font-bold text-teal-600">{Math.round(m.maturity_depth)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.maturity_depth}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Anti-Pattern Burden</p>
              <p className="text-3xl font-bold text-rose-600">{Math.round(m.antipattern_burden)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.antipattern_burden}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Anti-Pattern Clearance</p>
              <p className="text-3xl font-bold text-emerald-600">{Math.round(m.antipattern_clearance)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.antipattern_clearance}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Anti-Pattern Coverage</p>
              <p className="text-3xl font-bold text-slate-600">{Math.round(m.antipattern_coverage)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.antipattern_coverage}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Maturity Ratio</p>
              <p className="text-3xl font-bold text-violet-600">{Math.round(m.maturity_ratio)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.maturity_ratio}</p>
            </div>
          </div>
        </div>

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Assessment Metrics</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-stretch">
            {gauges.map(g => (
              <InlineSvg
                key={g.label}
                html={svgGaugeCard(g)}
                className=""
              />
            ))}
          </div>
        </div>

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Visual Diagnosis</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="chart-card">
              <h3>Category Footprint</h3>
              <p className="chart-desc">Per-domain maturity (emerald) vs anti-pattern burden (rose). Each axis is one assessment domain; values are the sum of sub-criterion counts (0–15) for that domain.</p>
              <InlineSvg html={svgRadar(result.phase_1_audit_logs)} />
            </div>
            <div className="chart-card">
              <h3>Position vs. Quadrants</h3>
              <p className="chart-desc">Validated maturity depth (x-axis) plotted against confirmed anti-pattern burden (y-axis). When evidence or anti-pattern coverage is insufficient, quadrant labels are suppressed.</p>
              <InlineSvg html={svgScatter(m.maturity_depth, m.antipattern_burden, isInsufficientEvidence)} />
            </div>
          </div>
        </div>

        <DomainSignalOverview result={result} />

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Evidence-Backed Findings</h2>
          {(() => {
            const evidence = result.phase_3_strategy.evidence_summary;
            if (!evidence) return null;
            const useSourceObservationTitle = isInsufficientEvidenceReport(
              evidence.maturity_classification,
              result.phase_2_validation.metrics.evidence_density,
              result.quality_gate.decision
            );
            const renderList = (title: string, items?: string[]) => {
              if (!items || items.length === 0) return null;
              return (
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">{title}</h3>
                  <ul className="space-y-1.5">
                    {items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                        <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdownHtml(item) }} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            };
            return (
              <div className="mb-8 p-6 rounded-xl bg-emerald-50/60 border border-emerald-200">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-5">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 mb-1">Fact-only current state</p>
                    <h3 className="text-xl font-display font-bold text-slate-900">{evidence.headline}</h3>
                  </div>
                  <span className="px-3 py-1 rounded-full bg-white border border-emerald-200 text-xs font-bold text-emerald-800 whitespace-nowrap">
                    {evidence.maturity_classification}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {renderList('Key metrics', evidence.key_metrics)}
                  {renderList(strengthsSectionTitle(useSourceObservationTitle), evidence.confirmed_strengths)}
                  {renderList('Confirmed gaps', evidence.confirmed_gaps)}
                  {renderList('Confirmed anti-patterns', evidence.confirmed_antipatterns)}
                  {renderList('Verified anti-pattern absences', result.phase_2_validation.verified_antipattern_absences)}
                  {renderList('Anti-patterns not assessable from source', result.phase_2_validation.unknown_antipattern_absences)}
                  {renderList('Silent / missing evidence', evidence.silent_or_missing_evidence)}
                </div>
              </div>
            );
          })()}
        </div>

        {(() => {
          const diagnosis = result.phase_3_strategy.diagnosis;
          if (!diagnosis) return null;
          const primaryBottleneck = diagnosis.primary_bottleneck?.trim();
          return (
            <div className="mb-12 p-6 rounded-xl bg-slate-50 border border-slate-200">
              <h2 className="text-2xl font-display font-bold text-slate-900 mb-2">Diagnosis</h2>
              <p className="text-sm text-slate-600 mb-5">Interpretation of the evidence. This section explains causes and bottlenecks, but does not prescribe the implementation plan.</p>
              {primaryBottleneck && (
                <div className="mb-5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Primary bottleneck</p>
                  <p className="text-slate-800">{primaryBottleneck}</p>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Root causes</p>
                  <ul className="space-y-1.5">
                    {(diagnosis.root_causes || []).map((item, i) => <li key={i} className="text-sm text-slate-700">• {item}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Domain diagnosis</p>
                  <ul className="space-y-1.5">
                    {computeDomainSignalRows(result).map(row => <li key={row.domain} className="text-sm text-slate-700"><span className="font-bold">{row.domain} · {row.title}:</span> Evidence {row.evidencePercent}%; maturity {row.maturityPercent}%; anti-pattern finding rate {row.antiPatternPercent}%.</li>)}
                  </ul>
                </div>
              </div>
              <div className="mt-5 p-4 rounded-lg bg-white border border-slate-200">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Diagnostic confidence: {diagnosis.confidence}</p>
                <p className="text-sm text-slate-700">{diagnosis.confidence_rationale}</p>
              </div>
            </div>
          );
        })()}

        {(() => {
          const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
          const withMaterial = claims.filter(isReportableSourceCoverageGap);
          if (withMaterial.length === 0) return null;
          const byType: Record<string, string[]> = {};
          for (const c of withMaterial) {
            const key = c.failure_type ? c.failure_type.replace(/_/g, ' ') : 'other';
            (byType[key] ||= []).push(c.missing_material!);
          }
          return (
            <div className="mb-12 p-6 rounded-xl bg-amber-50 border border-amber-200">
              <h2 className="text-xl font-display font-bold text-slate-900 mb-1">Source Coverage Gaps</h2>
              <p className="text-sm text-slate-600 mb-4">To strengthen the next assessment cycle, include the following kinds of evidence in the source document.</p>
              <div className="space-y-4">
                {Object.entries(byType).map(([type, materials]) => (
                  <div key={type}>
                    <p className="text-xs font-bold uppercase tracking-widest text-amber-700 mb-1.5">{type}</p>
                    <ul className="space-y-1">
                      {Array.from(new Set(materials)).map((m, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                          <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-500 shrink-0"></span>
                          <span>{m}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {(() => {
          const decision = result.phase_3_strategy.planning_decision;
          if (!decision) return null;
          const palette = decision.decision === 'GO'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
            : decision.decision === 'CONDITIONAL_GO'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-rose-50 border-rose-200 text-rose-900';
          return (
            <div className={`mb-12 p-6 rounded-xl border ${palette}`}>
              <h2 className="text-2xl font-display font-bold mb-2">Planning Decision: {decision.decision?.replace('_', ' ')}</h2>
              <p className="text-sm mb-5 opacity-90">{decision.rationale}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest mb-2 opacity-80">Safe to act on</p>
                  <ul className="space-y-1.5 text-sm">
                    {(decision.safe_to_act_on || []).map((item, i) => <li key={i}>• {item}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest mb-2 opacity-80">Evidence needed before action</p>
                  <ul className="space-y-1.5 text-sm">
                    {(decision.evidence_needed_before_action || []).map((item, i) => <li key={i}>• {item}</li>)}
                  </ul>
                </div>
              </div>
            </div>
          );
        })()}

        {(() => {
          const effective = result.phase_3_strategy.effective_bracket ?? result.phase_3_strategy.confidence_bracket;
          // LOW: findings panel replaces the roadmap entirely.
          if (effective === 'LOW' && result.phase_3_strategy.findings_mode) {
            return <FindingsPanel findings={result.phase_3_strategy.findings_mode} />;
          }
          if (effective === 'LOW' || result.quality_gate.decision === 'BLOCK') {
            return (
              <div className="mb-12 p-6 bg-rose-50/50 rounded-xl border border-rose-200">
                <h2 className="text-2xl font-display font-bold text-slate-900 mb-2">Remediation Roadmap Withheld</h2>
                <p className="text-sm text-slate-600">
                  Directive roadmap actions were withheld because the effective confidence bracket is LOW or the Quality Gate blocked the generated plan.
                  Use the evidence summary, planning decision, and validation plan before acting.
                </p>
              </div>
            );
          }
          // HIGH/MEDIUM: render the roadmap, with per-phase confidence + assumptions
          // surfaced when the synthesis populated them.
          if (result.phase_3_strategy.remediation_roadmap.length > 0) {
            return (
              <div className="mb-12">
                <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Remediation Roadmap</h2>
                <div className="space-y-6">
                  {result.phase_3_strategy.remediation_roadmap.map((step, index) => (
                    <RemediationStepBlock key={index} step={step} index={index} />
                  ))}
                </div>
              </div>
            );
          }
          return null;
        })()}

        <ForensicSection
          title="Forensic Audit: FinOps Maturity"
          stream="maturity"
          logs={result.phase_1_audit_logs.maturity}
          criticalLabel="Gaps only"
          criticalHint="gaps"
        />

        <ForensicSection
          title="Forensic Audit: Anti-Patterns"
          stream="antipattern"
          logs={result.phase_1_audit_logs.antipattern}
          criticalLabel="Red flags only"
          criticalHint="red flags"
        />

        <QualityGateAppendix gate={result.quality_gate} />

        <div className="text-center py-8 border-t border-slate-200 text-sm text-slate-400">
          <p>FinOps Assessment Engine v{result.meta.engine_version}</p>
          {result.meta.knowledge_base && (
            <p>
              Knowledge Base: {result.meta.knowledge_base.source === 'remote_blob'
                ? `Remote PDF KB loaded (${result.meta.knowledge_base.document_count} PDFs${result.meta.knowledge_base.failure_count ? `, ${result.meta.knowledge_base.failure_count} issue(s)` : ''})`
                : 'Built-in KB fallback'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
