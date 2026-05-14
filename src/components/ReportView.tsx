import React, { useState } from 'react';
import { AuditItem, DiagnosticResult, QualityGateResult, PersonaId, PERSONA_LABELS } from '../types';
import { MarkdownRenderer } from './DashboardComponents';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { METRIC_DESCRIPTIONS } from '../constants';
import { SVG_CSS, svgGaugeCard, svgRadar, svgScatter } from '../services/svgChartService';

const InlineSvg: React.FC<{ html: string; className?: string }> = ({ html, className }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
);

const QualityGateBlock: React.FC<{ gate: QualityGateResult }> = ({ gate }) => {
  if (gate.decision === 'GO') {
    return (
      <div className="mb-8 p-4 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm">
        <span className="font-bold">Quality Gate: GO</span> — {gate.notes[0]}
      </div>
    );
  }
  const isBlock = gate.decision === 'BLOCK';
  return (
    <div className={`mb-8 p-6 rounded-xl border-l-4 ${isBlock ? 'border-l-rose-600 bg-rose-50' : 'border-l-amber-600 bg-amber-50'}`}>
      <h2 className={`text-xl font-bold mb-2 ${isBlock ? 'text-rose-800' : 'text-amber-800'}`}>
        Quality Gate: {gate.decision}
      </h2>
      <p className="text-sm text-slate-700 mb-4">{gate.notes[0]}</p>
      {gate.blocking_reasons.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-bold uppercase tracking-wider text-rose-700 mb-2">Blocking</p>
          <ul className="space-y-1.5 text-sm text-slate-700">
            {gate.blocking_reasons.map((r, i) => (
              <li key={i} className="pl-3 border-l-2 border-rose-400">{r}</li>
            ))}
          </ul>
        </div>
      )}
      {gate.warnings.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-amber-700 mb-2">Warnings</p>
          <ul className="space-y-1.5 text-sm text-slate-700">
            {gate.warnings.map((w, i) => (
              <li key={i} className="pl-3 border-l-2 border-amber-400">{w}</li>
            ))}
          </ul>
        </div>
      )}
      {gate.fact_check && !gate.fact_check.failed && gate.fact_check.unsupported_claims.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-300">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
            Unverified claims ({gate.fact_check.unsupported_claims.length} survived {gate.fact_check.attempts} pass{gate.fact_check.attempts === 1 ? '' : 'es'})
          </p>
          <ul className="space-y-2 text-sm text-slate-700">
            {gate.fact_check.unsupported_claims.map((c, i) => (
              <li key={i} className="pl-3 border-l-2 border-slate-400">
                <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                {c.rationale && <span className="block text-xs text-slate-500 mt-0.5">{c.rationale}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const BATCHES: Array<'A' | 'B' | 'C' | 'D' | 'E'> = ['A', 'B', 'C', 'D', 'E'];

const statusBadgeClass = (status: string): string => {
  if (status === 'OK') return 'bg-emerald-100 text-emerald-700';
  if (status === 'NOK') return 'bg-rose-100 text-rose-700';
  if (status === 'Partial') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-500';
};

const ForensicCriterion: React.FC<{
  catalog: { id: string; title: string; desc: string };
  item?: AuditItem;
}> = ({ catalog, item }) => (
  <div className="p-5 bg-white rounded-xl border border-slate-200">
    <div className="flex items-start justify-between gap-4 mb-2">
      <div className="min-w-0">
        <span className="font-mono text-xs text-slate-400">{catalog.id}</span>
        <h4 className="font-bold text-slate-900 leading-snug">{catalog.title}</h4>
      </div>
      <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider shrink-0 ${statusBadgeClass(item?.status ?? '')}`}>
        {item?.status ?? 'No Data'}
      </span>
    </div>
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
  const isCritical = (item?: AuditItem): boolean => item?.status === 'NOK';
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
                    <ForensicCriterion key={cat.id} catalog={cat} item={logs[cat.id]} />
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

interface ReportViewProps {
  result: DiagnosticResult;
  onBack: () => void;
  onDownload: () => void;
}

export const ReportView: React.FC<ReportViewProps> = ({ result, onBack, onDownload }) => {
  const m = result.phase_2_validation.metrics;
  const cwrClass = result.phase_2_validation.crawl_walk_run;

  const gauges = [
    { value: m.finops_readiness, label: 'FinOps Readiness', color: '#10b981', description: METRIC_DESCRIPTIONS.finops_readiness, trend: 'positive' as const, size: 'large' as const },
    { value: m.maturity_ratio, label: 'Maturity Level', color: '#14b8a6', description: METRIC_DESCRIPTIONS.maturity_ratio, trend: 'positive' as const },
    { value: m.maturity_depth, label: 'Maturity Depth', color: '#06b6d4', description: METRIC_DESCRIPTIONS.maturity_depth, trend: 'positive' as const },
    { value: m.antipattern_ratio, label: 'Anti-Pattern Level', color: '#f43f5e', description: METRIC_DESCRIPTIONS.antipattern_ratio, trend: 'negative' as const },
    { value: m.antipattern_burden, label: 'Anti-Pattern Burden', color: '#e11d48', description: METRIC_DESCRIPTIONS.antipattern_burden, trend: 'negative' as const },
    { value: m.delivery_integrity, label: 'Delivery Integrity', color: '#475569', description: METRIC_DESCRIPTIONS.delivery_integrity, trend: 'positive' as const },
    { value: m.evidence_density, label: 'Evidence Density', color: '#475569', description: METRIC_DESCRIPTIONS.evidence_density, trend: 'positive' as const }
  ];

  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans">
      <style>{SVG_CSS}</style>
      <div className="sticky top-0 z-50 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-6 py-4 flex justify-between items-center">
          <button onClick={onBack} className="text-sm font-bold text-slate-500 hover:text-slate-900 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back to Dashboard
          </button>
          <button onClick={onDownload} className="px-6 py-2 bg-slate-900 text-white rounded-lg font-bold text-sm hover:bg-emerald-600 transition-colors">
            Download Report
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-display font-bold text-slate-900 mb-2">FinOps Maturity Assessment</h1>
          <p className="text-slate-500">Generated: {result.meta.timestamp} | Engine: {result.meta.engine_version}</p>
        </div>

        <QualityGateBlock gate={result.quality_gate} />

        <div className="mb-12 p-8 bg-slate-50 rounded-2xl border border-slate-200">
          <div className="flex items-center gap-4 mb-6">
            <span className={`px-4 py-2 rounded-lg font-bold text-sm ${cwrClass.includes('Crawl') ? 'bg-rose-100 text-rose-700' : cwrClass.includes('Run') ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {cwrClass}
            </span>
            <span className="text-slate-400">|</span>
            <span className="text-sm font-mono text-slate-500">
              Delivery {m.delivery_integrity}% · Evidence {m.evidence_density}%
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">FinOps Readiness</p>
              <p className="text-3xl font-bold text-emerald-600">{Math.round(m.finops_readiness)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.finops_readiness}</p>
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
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Maturity Ratio</p>
              <p className="text-3xl font-bold text-violet-600">{Math.round(m.maturity_ratio)}%</p>
              <p className="text-xs text-slate-500 mt-1 leading-snug">{METRIC_DESCRIPTIONS.maturity_ratio}</p>
            </div>
          </div>
        </div>

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Maturity Gauges</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-stretch">
            {gauges.map((g, i) => (
              <InlineSvg
                key={g.label}
                html={svgGaugeCard(g)}
                className={i === 0 ? 'col-span-2 md:col-span-3' : ''}
              />
            ))}
          </div>
        </div>

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Visual Diagnosis</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="chart-card">
              <h3>Category Footprint</h3>
              <p className="chart-desc">Per-domain maturity (emerald) vs anti-pattern burden (rose). Each axis is one of the five batches; values are the sum of sub-criterion counts (0–15) for that batch.</p>
              <InlineSvg html={svgRadar(result.phase_1_audit_logs)} />
            </div>
            <div className="chart-card">
              <h3>Position vs. Quadrants</h3>
              <p className="chart-desc">FinOps Readiness (x-axis) plotted against Anti-Pattern Burden (y-axis). The bottom-right quadrant is the goal: high readiness, low burden.</p>
              <InlineSvg html={svgScatter(m.finops_readiness, m.antipattern_burden)} />
            </div>
          </div>
        </div>

        <div className="mb-12">
          <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Executive Summary</h2>
          {(() => {
            const summaries = result.phase_3_strategy.executive_summaries;
            const ids: PersonaId[] = ['finops_lead', 'cfo', 'engineering_lead'];
            const unsupported = result.quality_gate?.fact_check?.unsupported_claims || [];
            const attempts = result.quality_gate?.fact_check?.attempts || 0;
            if (summaries && ids.some(id => summaries[id])) {
              return (
                <div className="space-y-8">
                  {ids.map(id => {
                    const personaClaims = unsupported.filter(c => c.source_location === id);
                    return (
                      <div key={id}>
                        <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-700 mb-3">For the {PERSONA_LABELS[id]}</h3>
                        <MarkdownRenderer content={summaries[id]} textColor="text-slate-700" />
                        {personaClaims.length > 0 && (
                          <div className="mt-4 p-4 rounded-lg bg-amber-50 border border-amber-200">
                            <p className="text-xs font-bold uppercase tracking-widest text-amber-700 mb-2">Confidence Notes — Unverified Claims</p>
                            <p className="text-xs text-amber-800 mb-2">The following statements could not be verified against the source after {attempts} regenerate pass(es). Treat with caution.</p>
                            <ul className="space-y-1.5">
                              {personaClaims.map((c, i) => (
                                <li key={i} className="text-sm text-amber-900">
                                  <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                                  <span className="block text-xs text-amber-700 mt-0.5">{c.rationale}{c.failure_type ? ` · ${c.failure_type.replace(/_/g, ' ')}` : ''}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }
            return <MarkdownRenderer content={result.phase_3_strategy.executive_summary} textColor="text-slate-700" />;
          })()}
        </div>

        {(() => {
          const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
          const withMaterial = claims.filter(c => c.missing_material);
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

        {result.phase_3_strategy.remediation_roadmap.length > 0 && (
          <div className="mb-12">
            <h2 className="text-2xl font-display font-bold text-slate-900 mb-6 pb-3 border-b border-slate-200">Remediation Roadmap</h2>
            <div className="space-y-6">
              {result.phase_3_strategy.remediation_roadmap.map((step, index) => (
                <div key={index} className="p-6 bg-slate-50 rounded-xl border border-slate-200">
                  <h3 className="font-bold text-lg text-slate-900 mb-4">{step.phase}</h3>
                  <ul className="space-y-3">
                    {step.actions.map((action, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                        <span>{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

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

        <div className="text-center py-8 border-t border-slate-200 text-sm text-slate-400">
          <p>FinOps Assessment Engine v{result.meta.engine_version}</p>
          <p>Models: {result.meta.model_config.phase0_phase1} (Audit) | {result.meta.model_config.phase3} (Strategy)</p>
        </div>
      </div>
    </div>
  );
};
