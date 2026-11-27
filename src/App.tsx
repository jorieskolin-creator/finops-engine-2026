import React, { useState, useRef, useEffect } from 'react';
import { analyzeDocument } from './services/analysisService';
import { scanInputText } from './services/preFlightService';
import type { PdfParseQuality } from './services/pdfService';
import { parseEvidenceFile, toEvidenceSourceRecords, type ParsedEvidenceFile } from './services/evidenceIntakeService';
import { downloadAssessmentJson, downloadMasterDataReport, downloadRunTraceJson, downloadSummaryReport } from './services/exportService';
import { extractDiagnosticResultFromHtmlReport, isDiagnosticResultPayload, parseDiagnosticResultJson, serializeDiagnosticResultForHtml } from './services/reportImportService';
import { findGeneratedReportPrivacyFindings, scrubDiagnosticResultForPrivacy } from './services/privacyService';
import { PerformanceMonitor } from './services/debugService';
import { DiagnosticResult, ScanResult, PersonaId, PERSONA_IDS, PERSONA_LABELS, PipelineProgressStage, PipelineProgressUpdate } from './types';
import { METRIC_DESCRIPTIONS } from './constants';
import { GaugeCard, AuditGrid, StrategicRoadmap, ComparisonChart, ReferenceLibrary, QualityGateBanner, BenchmarkingChart, TransferProtocol, MarkdownRenderer, NeuralLoadingGrid } from './components/DashboardComponents';
import { ReportView } from './components/ReportView';
import { GoldenStandardStatus } from './components/GoldenStandardStatus';
import { useOpeningRetrievalCheck } from './monitoring/useOpeningRetrievalCheck';
import { LoginModal } from './components/LoginModal';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { checkSession, logout } from './services/authService';
import { acknowledgeRun, deleteRun, getRun } from './services/runLifecycleService';
import { recoverCheckpointResult } from './services/checkpointRecoveryService';
import { buildReportViewModel } from './services/reportViewModel';
import { createReportNarrative } from './services/reportNarrativeService';

const APP_VERSION_LABEL = 'FinOps Engine v.3.0.0';
const SAVED_ASSESSMENT_KEY = 'finops:last-assessment:v1';
const SAVED_ASSESSMENT_META_KEY = 'finops:last-assessment-meta:v1';
const LAST_CRASH_KEY = 'finops:last-crash:v1';
const ACTIVE_RUN_KEY = 'finops:recoverable-run:v1';

interface SavedAssessmentMeta {
  savedAt: string;
  source: 'completed_assessment' | 'html_import' | 'json_import';
  documentAnalyzed?: string;
}

const readSavedAssessment = (): DiagnosticResult | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SAVED_ASSESSMENT_KEY);
    if (!raw) return null;
    const parsed = parseDiagnosticResultJson(raw);
    return parsed.kind === 'report' ? parsed.result : null;
  } catch {
    return null;
  }
};

const readSavedAssessmentMeta = (): SavedAssessmentMeta | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SAVED_ASSESSMENT_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const saveAssessmentToSession = (result: DiagnosticResult, source: SavedAssessmentMeta['source'] = 'completed_assessment') => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SAVED_ASSESSMENT_KEY, serializeDiagnosticResultForHtml(result));
    window.sessionStorage.setItem(SAVED_ASSESSMENT_META_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      source,
      documentAnalyzed: result.meta?.document_analyzed
    } satisfies SavedAssessmentMeta));
  } catch (error) {
    console.warn('[FinOps] Could not save assessment recovery payload (error_code=RECOVERY_SAVE_FAILED).');
  }
};

const clearSavedAssessment = () => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SAVED_ASSESSMENT_KEY);
    window.sessionStorage.removeItem(SAVED_ASSESSMENT_META_KEY);
    window.sessionStorage.removeItem(LAST_CRASH_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
};

const saveLastCrash = (message: string, componentStack?: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(LAST_CRASH_KEY, JSON.stringify({
      at: new Date().toISOString(),
      message,
      componentStack: componentStack?.slice(0, 4000)
    }));
  } catch {
    // Ignore unavailable browser storage.
  }
};

const readLastCrash = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LAST_CRASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
};

const clearLastCrash = () => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(LAST_CRASH_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
};

const cloneResult = (result: DiagnosticResult): DiagnosticResult =>
  typeof structuredClone === 'function'
    ? structuredClone(result)
    : JSON.parse(JSON.stringify(result));

const arrayToText = (items?: string[]): string => (items || []).join('\n');

const textToArray = (text: string): string[] =>
  text.split('\n').map(line => line.trim()).filter(Boolean);

interface UploadedFile extends ParsedEvidenceFile {
  id: string;
  status: 'parsed' | 'error';
  scan?: ScanResult;
}

const acquisitionErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return message.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] || 'EVIDENCE_FILE_REJECTED';
};

const PrivacyProtocolCard = () => (
  <section id="data-handling" aria-labelledby="data-handling-title" className="finops-card mt-5 scroll-mt-32 p-5 sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="finops-kicker">Privacy and retention</p>
        <h2 id="data-handling-title" className="mt-1 text-xl font-bold tracking-tight">Data Handling Overview</h2>
      </div>
      <a
        href="/data-handling.html"
        target="_blank"
        rel="noopener noreferrer"
        className="finops-button"
      >
        Data Handling &amp; Privacy Guide
      </a>
    </div>
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[
        { icon: 'M13 10V3L4 14h7v7l9-11h-7z', title: "Browser Parsing", desc: "Files parsed on this device" },
        { icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', title: "Provider Processing", desc: "Parsed content sent to configured LLMs" },
        { icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', title: "Session Recovery", desc: "Report saved in this browser tab" },
        { icon: 'M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88', title: "Deterministic Privacy", desc: "Complete acquired content checked before AI" }
      ].map((item, idx) => (
        <div key={idx} className="flex items-start gap-3 rounded-xl border border-finops-line bg-finops-soft p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-finops-sage text-finops-forest">
            <svg aria-hidden="true" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={item.icon} /></svg>
          </div>
          <div>
            <h3 className="text-sm font-bold">{item.title}</h3>
            <p className="text-xs text-finops-muted">{item.desc}</p>
          </div>
        </div>
      ))}
    </div>
    <p className="mt-4 border-t border-finops-line pt-4 text-sm leading-relaxed text-finops-muted">
      Files, full tables, images and sparse PDF pages are processed locally. Images and sparse pages use local OCR; OCR does not interpret graph structure or other non-text visual semantics, which remain explicitly withheld. Deterministic privacy controls scan and redact acquired content before governed packets are assembled. The first generative-model call occurs only after that boundary passes. Provider retention depends on the configured account terms. Canonical governed packet bodies remain temporarily in PostgreSQL, while accepted analysis checkpoints may remain temporarily in Redis for interruption recovery. Packet bodies and Redis transient content are deleted after the browser acknowledges final report delivery, on explicit deletion, or at expiry; content-free PostgreSQL metadata and hashes remain for audit retention.
    </p>
  </section>
);

const PrivacyReviewPanel: React.FC<{
  result: DiagnosticResult;
  edited: boolean;
  notice: string | null;
  organizationRedactionTerm: string;
  onOrganizationRedactionTermChange: (value: string) => void;
  onApplyPersonRedaction: () => void;
  onApplyOrganizationRedaction: () => void;
  onPreview: () => void;
  onChange: (updater: (draft: DiagnosticResult) => void) => void;
}> = ({
  result,
  edited,
  notice,
  organizationRedactionTerm,
  onOrganizationRedactionTermChange,
  onApplyPersonRedaction,
  onApplyOrganizationRedaction,
  onPreview,
  onChange
}) => {
  const strategy = result.phase_3_strategy;
  const evidence = strategy.evidence_summary;
  const diagnosis = strategy.diagnosis;
  const planning = strategy.planning_decision;
  const roadmap = strategy.remediation_roadmap || [];

  const textareaClass = 'w-full min-h-[90px] rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-400 focus:outline-none';
  const labelClass = 'text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 block';

  return (
    <div className="glass-panel p-6 md:p-8 rounded-[2rem] bg-slate-900/50 border border-emerald-500/20">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className="text-xl font-display font-bold text-white">Privacy Review / Edit Report</h3>
            {edited && <span className="px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-bold uppercase tracking-widest text-emerald-300">Edited locally</span>}
          </div>
          <p className="text-sm text-slate-400 max-w-3xl">
            These edits apply only to generated report wording and exported HTML/JSON. Raw source evidence remains unchanged inside this browser session for audit traceability.
          </p>
          {notice && <p className="mt-3 text-sm text-amber-200">{notice}</p>}
        </div>
        <button
          type="button"
          onClick={onPreview}
          className="px-4 py-2 rounded-xl bg-white text-slate-950 text-xs font-bold uppercase tracking-widest hover:bg-emerald-100 transition-colors"
        >
          Preview exported report
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <button
          type="button"
          onClick={onApplyPersonRedaction}
          className="px-4 py-3 rounded-xl bg-slate-800 text-slate-100 text-xs font-bold uppercase tracking-widest hover:bg-slate-700 transition-colors"
        >
          Redact detected person names
        </button>
        <input
          value={organizationRedactionTerm}
          onChange={(e) => onOrganizationRedactionTermChange(e.target.value)}
          placeholder="Organization name to redact"
          className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={onApplyOrganizationRedaction}
          disabled={!organizationRedactionTerm.trim()}
          className="px-4 py-3 rounded-xl bg-slate-800 text-slate-100 text-xs font-bold uppercase tracking-widest hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Redact organization name
        </button>
      </div>

      <div className="space-y-8">
        <section>
          <h4 className="text-sm font-bold uppercase tracking-widest text-emerald-300 mb-4">Executive summaries</h4>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {PERSONA_IDS.map(persona => (
              <label key={persona} className="block">
                <span className={labelClass}>{PERSONA_LABELS[persona]}</span>
                <textarea
                  className={textareaClass}
                  value={strategy.executive_summaries?.[persona] || (persona === 'finops_lead' ? strategy.executive_summary || '' : '')}
                  onChange={(e) => onChange(draft => {
                    draft.phase_3_strategy.executive_summaries = {
                      ...(draft.phase_3_strategy.executive_summaries || {}),
                      [persona]: e.target.value
                    } as any;
                    if (persona === 'finops_lead') draft.phase_3_strategy.executive_summary = e.target.value;
                  })}
                />
              </label>
            ))}
          </div>
        </section>

        {evidence && (
          <section>
            <h4 className="text-sm font-bold uppercase tracking-widest text-emerald-300 mb-4">Evidence summary</h4>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <label className="block">
                <span className={labelClass}>Headline</span>
                <textarea
                  className={textareaClass}
                  value={evidence.headline || ''}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.evidence_summary) draft.phase_3_strategy.evidence_summary.headline = e.target.value; })}
                />
              </label>
              {(['key_metrics', 'confirmed_strengths', 'confirmed_gaps', 'confirmed_antipatterns', 'silent_or_missing_evidence'] as const).map(field => (
                <label key={field} className="block">
                  <span className={labelClass}>{field.replace(/_/g, ' ')}</span>
                  <textarea
                    className={textareaClass}
                    value={arrayToText(evidence[field])}
                    onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.evidence_summary) (draft.phase_3_strategy.evidence_summary as any)[field] = textToArray(e.target.value); })}
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        {diagnosis && (
          <section>
            <h4 className="text-sm font-bold uppercase tracking-widest text-emerald-300 mb-4">Diagnosis</h4>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <label className="block lg:col-span-2">
                <span className={labelClass}>Executive summary</span>
                <textarea
                  className={textareaClass}
                  value={diagnosis.executive_summary || ''}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.diagnosis) draft.phase_3_strategy.diagnosis.executive_summary = e.target.value; })}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Primary bottleneck</span>
                <textarea
                  className={textareaClass}
                  value={diagnosis.primary_bottleneck || ''}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.diagnosis) draft.phase_3_strategy.diagnosis.primary_bottleneck = e.target.value; })}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Root causes</span>
                <textarea
                  className={textareaClass}
                  value={arrayToText(diagnosis.root_causes)}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.diagnosis) draft.phase_3_strategy.diagnosis.root_causes = textToArray(e.target.value); })}
                />
              </label>
              <label className="block lg:col-span-2">
                <span className={labelClass}>Domain diagnosis</span>
                <textarea
                  className={`${textareaClass} min-h-[140px]`}
                  value={Object.entries(diagnosis.domain_diagnosis || {}).map(([domain, text]) => `${domain}: ${text}`).join('\n')}
                  onChange={(e) => onChange(draft => {
                    if (!draft.phase_3_strategy.diagnosis) return;
                    draft.phase_3_strategy.diagnosis.domain_diagnosis = Object.fromEntries(
                      e.target.value.split('\n')
                        .map(line => line.trim())
                        .filter(Boolean)
                        .map(line => {
                          const idx = line.indexOf(':');
                          return idx >= 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line, ''];
                        })
                    );
                  })}
                />
              </label>
            </div>
          </section>
        )}

        {planning && (
          <section>
            <h4 className="text-sm font-bold uppercase tracking-widest text-emerald-300 mb-4">Planning decision</h4>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <label className="block lg:col-span-3">
                <span className={labelClass}>Rationale</span>
                <textarea
                  className={textareaClass}
                  value={planning.rationale || ''}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.planning_decision) draft.phase_3_strategy.planning_decision.rationale = e.target.value; })}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Safe to act on</span>
                <textarea
                  className={textareaClass}
                  value={arrayToText(planning.safe_to_act_on)}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.planning_decision) draft.phase_3_strategy.planning_decision.safe_to_act_on = textToArray(e.target.value); })}
                />
              </label>
              <label className="block lg:col-span-2">
                <span className={labelClass}>Evidence needed before action</span>
                <textarea
                  className={textareaClass}
                  value={arrayToText(planning.evidence_needed_before_action)}
                  onChange={(e) => onChange(draft => { if (draft.phase_3_strategy.planning_decision) draft.phase_3_strategy.planning_decision.evidence_needed_before_action = textToArray(e.target.value); })}
                />
              </label>
            </div>
          </section>
        )}

        {roadmap.length > 0 && (
          <section>
            <h4 className="text-sm font-bold uppercase tracking-widest text-emerald-300 mb-4">Roadmap</h4>
            <div className="space-y-4">
              {roadmap.map((step, index) => (
                <div key={index} className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <label className="block">
                      <span className={labelClass}>Phase title</span>
                      <input
                        value={step.phase || ''}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].phase = e.target.value; })}
                        className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>Confidence</span>
                      <input
                        value={step.confidence || ''}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].confidence = e.target.value as any; })}
                        className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>Why</span>
                      <textarea
                        className={textareaClass}
                        value={step.why || ''}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].why = e.target.value; })}
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>What</span>
                      <textarea
                        className={textareaClass}
                        value={step.what || ''}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].what = e.target.value; })}
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>Deliverables</span>
                      <textarea
                        className={textareaClass}
                        value={arrayToText(step.deliverables)}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].deliverables = textToArray(e.target.value); })}
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>How / actions</span>
                      <textarea
                        className={textareaClass}
                        value={arrayToText(step.actions)}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].actions = textToArray(e.target.value); })}
                      />
                    </label>
                    <label className="block">
                      <span className={labelClass}>Assumptions</span>
                      <textarea
                        className={textareaClass}
                        value={arrayToText(step.assumptions)}
                        onChange={(e) => onChange(draft => { draft.phase_3_strategy.remediation_roadmap[index].assumptions = textToArray(e.target.value); })}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  const [aggregatedText, setAggregatedText] = useState('');
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState<Partial<Record<PipelineProgressStage, PipelineProgressUpdate>>>({});
  const [completedDomains, setCompletedDomains] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'audit' | 'strategy' | 'reference'>('overview');
  const [viewMode, setViewMode] = useState<'dashboard' | 'report'>('dashboard');
  const [scanResult, setScanResult] = useState<ScanResult>({ score: 0, status: 'Insufficient', message: 'Waiting...', details: [], canRun: false });
  const [authenticated, setAuthenticated] = useState(false);
  const openingRetrievalCheck = useOpeningRetrievalCheck(authenticated);
  const [showLogin, setShowLogin] = useState(false);
  const [activePersona, setActivePersona] = useState<PersonaId>('finops_lead');
  const [deepMode, setDeepMode] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [hasSavedAssessment, setHasSavedAssessment] = useState(false);
  const [safeRecoveryResult, setSafeRecoveryResult] = useState<DiagnosticResult | null>(null);
  const [safeRecoveryMeta, setSafeRecoveryMeta] = useState<SavedAssessmentMeta | null>(null);
  const [lastCrashMessage, setLastCrashMessage] = useState<string | null>(null);
  const [errorBoundaryResetKey, setErrorBoundaryResetKey] = useState(0);
  const [privacyPanelOpen, setPrivacyPanelOpen] = useState(false);
  const [privacyEdited, setPrivacyEdited] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState<string | null>(null);
  const [organizationRedactionTerm, setOrganizationRedactionTerm] = useState('');
  const pendingAnalyzeRef = useRef(false);
  const nextRecoverySourceRef = useRef<SavedAssessmentMeta['source']>('completed_assessment');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clearFileInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const prepareResultForDisplay = (
    next: DiagnosticResult,
    source: SavedAssessmentMeta['source'] = 'completed_assessment'
  ): DiagnosticResult => {
    const scrubbed = scrubDiagnosticResultForPrivacy(next, { redactPersonNames: true });
    nextRecoverySourceRef.current = source;
    setPrivacyEdited(prev => prev || scrubbed.changed);
    if (scrubbed.replacements > 0) {
      setPrivacyNotice(`Privacy scrubber redacted ${scrubbed.replacements} item(s) in generated report text. Review before sharing.`);
    } else if (scrubbed.potentialNames.length > 0) {
      setPrivacyNotice('Potential names detected in generated report text. Review before sharing.');
    }
    return scrubbed.result;
  };

  const setPreparedResult = (
    next: DiagnosticResult,
    source: SavedAssessmentMeta['source'] = 'completed_assessment'
  ) => {
    setSafeRecoveryResult(null);
    setResult(prepareResultForDisplay(next, source));
  };

  const clearTraceAfterLocalEdit = (draft: DiagnosticResult) => {
    delete draft.meta.run_trace;
    delete draft.meta.run_trace_summary;
  };

  const updateCurrentResult = (updater: (draft: DiagnosticResult) => void) => {
    setResult(prev => {
      if (!prev) return prev;
      const draft = cloneResult(prev);
      updater(draft);
      clearTraceAfterLocalEdit(draft);
      setPrivacyEdited(true);
      setPrivacyNotice('Report text edited locally. Exports will use this edited version; RunTrace was removed because provenance no longer matches the edited wording.');
      return draft;
    });
  };

  const applyPersonRedaction = () => {
    if (!result) return;
    const scrubbed = scrubDiagnosticResultForPrivacy(result, { redactPersonNames: true });
    clearTraceAfterLocalEdit(scrubbed.result);
    setResult(scrubbed.result);
    setPrivacyEdited(prev => prev || scrubbed.changed);
    setPrivacyNotice(scrubbed.replacements > 0
      ? `Redacted ${scrubbed.replacements} detected item(s) in generated report text. RunTrace was removed because provenance no longer matches the redacted wording.`
      : 'No additional deterministic person-name patterns were found. RunTrace was removed because privacy review was applied.');
  };

  const applyOrganizationRedaction = () => {
    if (!result || !organizationRedactionTerm.trim()) return;
    const scrubbed = scrubDiagnosticResultForPrivacy(result, {
      redactPersonNames: false,
      redactOrganizationName: organizationRedactionTerm.trim()
    });
    clearTraceAfterLocalEdit(scrubbed.result);
    setResult(scrubbed.result);
    setPrivacyEdited(prev => prev || scrubbed.changed);
    setPrivacyNotice(scrubbed.replacements > 0
      ? `Redacted ${scrubbed.replacements} organization-name occurrence(s) in generated report text. RunTrace was removed because provenance no longer matches the redacted wording.`
      : 'That organization name was not found in generated report text. RunTrace was removed because privacy review was applied.');
  };

  useEffect(() => {
    checkSession().then(setAuthenticated);
    const saved = readSavedAssessment();
    setHasSavedAssessment(Boolean(saved));
    if (saved) {
      const crashMessage = readLastCrash();
      if (crashMessage) {
        setSafeRecoveryResult(saved);
        setSafeRecoveryMeta(readSavedAssessmentMeta());
        setLastCrashMessage(crashMessage);
        setRecoveryNotice('A saved assessment was found after a view crash. Opened recovery mode so you can download or retry safely.');
      } else {
        setResult(saved);
        if (findGeneratedReportPrivacyFindings(saved).length > 0) {
          setPrivacyNotice('Potential names detected in generated report text. Review before sharing.');
        }
        setRecoveryNotice('Restored the last completed assessment from this browser session.');
      }
    }
  }, []);

  useEffect(() => {
    if (!authenticated || result || safeRecoveryResult || loading || typeof window === 'undefined') return;
    const runId = window.localStorage.getItem(ACTIVE_RUN_KEY);
    if (!runId) return;
    void (async () => {
      try {
        const run = await getRun(runId);
        const recoverable = ['recovery_required', 'ready_for_delivery'].includes(run.state)
          || (run.state === 'completed' && run.cleanup_status !== 'verified');
        if (!recoverable) {
          window.localStorage.removeItem(ACTIVE_RUN_KEY);
          return;
        }
        const recovered = await recoverCheckpointResult(runId);
        if (!recovered) return;
        saveAssessmentToSession(recovered.result, 'completed_assessment');
        setPreparedResult(recovered.result, 'completed_assessment');
        setViewMode('dashboard');
        setRecoveryNotice(recovered.complete
          ? 'Recovered the completed assessment from temporary storage after interruption.'
          : 'Recovered accepted analysis checkpoints. The run did not finish verification, so the report is BLOCK / NO_GO and contains no roadmap.');
        if (['ready_for_delivery', 'completed'].includes(run.state) && recovered.complete) {
          await acknowledgeRun(runId);
          window.localStorage.removeItem(ACTIVE_RUN_KEY);
        }
      } catch {
        setRecoveryNotice('A recoverable run was found, but its temporary checkpoint is currently unavailable. It will remain available until expiry.');
      }
    })();
  }, [authenticated, loading, result, safeRecoveryResult]);

  useEffect(() => {
    if (!authenticated || loading || !result?.meta?.run_id || typeof window === 'undefined') return;
    const runId = window.localStorage.getItem(ACTIVE_RUN_KEY);
    if (runId !== result.meta.run_id) return;
    void getRun(runId).then(async run => {
      if (run.state === 'ready_for_delivery' || (run.state === 'completed' && run.cleanup_status !== 'verified')) {
        await acknowledgeRun(runId);
      }
      if (run.state !== 'recovery_required') window.localStorage.removeItem(ACTIVE_RUN_KEY);
    }).catch(() => undefined);
  }, [authenticated, loading, result]);

  useEffect(() => {
    if (!result) return;
    saveAssessmentToSession(result, nextRecoverySourceRef.current);
    nextRecoverySourceRef.current = 'completed_assessment';
    setHasSavedAssessment(true);
  }, [result]);

  const MIN_FILES = 2;
  const MAX_FILES = 30;
  const MAX_FILE_SIZE_MB = 25;
  const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
  const MAX_TOTAL_UPLOAD_MB = 50;
  const MAX_TOTAL_UPLOAD_BYTES = MAX_TOTAL_UPLOAD_MB * 1024 * 1024;

  const makeLowRelevanceWarning = (scan: ScanResult, kind?: UploadedFile['kind']): ScanResult => ({
    ...scan,
    status: 'PassWithWarning',
    message: kind === 'csv' || kind === 'tsv' || kind === 'xlsx' ? 'Tabular input accepted' : 'Low relevance warning',
    canRun: true,
    confidence_warning: scan.confidence_warning || 'This file has weak FinOps keyword signal. The assessment will run, but unsupported areas should be treated as insufficient evidence.',
    details: [
      ...scan.details,
      'Accepted as parseable source material; evidence gates will determine whether it supports FinOps findings.'
    ]
  });

  const scanParseableFile = (text: string, kind?: UploadedFile['kind'], hasImages = false): ScanResult => {
    const scan = scanInputText(text);
    if (scan.canRun) return scan;
    if (hasImages || text.trim().length > 0) return makeLowRelevanceWarning(scan, kind);
    return scan;
  };

  const parseQualityLabel = (quality?: PdfParseQuality['quality']): string | null => {
    if (quality === 'good') return 'Complete text/OCR acquisition';
    if (quality === 'mixed') return 'Acquired with declared sparse/visual limitations';
    if (quality === 'poor') return 'Blocked: required page acquisition incomplete';
    return null;
  };

  const sourceParseWarningsForFiles = (sourceFiles: UploadedFile[]): string[] => {
    return sourceFiles
      .map((file, index) => ({ file, sourceLabel: `Document ${String(index + 1).padStart(3, '0')}` }))
      .filter(({ file }) => file.parseMetadata?.parseQuality && file.parseMetadata.parseQuality.quality !== 'good')
      .flatMap(({ file, sourceLabel }) => {
        const parseQuality = file.parseMetadata!.parseQuality!;
        const warnings = parseQuality.warnings.length > 0
          ? parseQuality.warnings
          : ['PDF text extraction may be incomplete.'];
        return warnings.map(warning => `${sourceLabel}: ${warning}`);
      });
  };

  useEffect(() => {
    const combined = files
      .filter(f => f.text && f.text.length > 0)
      .map(f => f.text)
      .join('\n');
    setAggregatedText(combined);
  }, [files]);

  useEffect(() => {
    if (!aggregatedText) {
      setScanResult({ score: 0, status: 'Insufficient', message: 'Upload Required', details: [], canRun: false });
      return;
    }
    const timer = setTimeout(() => {
      PerformanceMonitor.start('GlobalScan');
      const globalScan = scanInputText(aggregatedText);
      if (!globalScan.canRun && files.length > 0) {
        globalScan.canRun = true;
        globalScan.status = 'PassWithWarning';
        globalScan.message = 'Low relevance warning';
        globalScan.confidence_warning = globalScan.confidence_warning || 'Input appears weak or generic. The engine will run and evidence gates should classify unsupported areas as insufficient evidence.';
        globalScan.details = [
          ...globalScan.details,
          'Parseable source material is accepted; low relevance is handled by Phase 1 evidence checks and Phase 2 quality gates.'
        ];
      }
      const fileCountValid = files.length >= MIN_FILES && files.length <= MAX_FILES;
      if (!fileCountValid) {
        globalScan.canRun = false;
        globalScan.message = files.length < MIN_FILES ? "Need more files" : "Too many files";
      }
      const lowSignalFiles = files.filter(f => f.scan && (f.scan.status === 'Insufficient' || f.scan.status === 'PassWithWarning'));
      if (lowSignalFiles.length > 0) {
        globalScan.status = globalScan.status === 'Ready' ? 'PassWithWarning' : globalScan.status;
        globalScan.details.push(`${lowSignalFiles.length} file(s) have low FinOps keyword signal and will be assessed with evidence-gated confidence.`);
      }
      setScanResult(globalScan);
      PerformanceMonitor.end('GlobalScan');
    }, 300);
    return () => clearTimeout(timer);
  }, [aggregatedText, files]);

  const processSelectedFiles = async (newFiles: File[]) => {
    if (newFiles.length === 1) {
      const file = newFiles[0];
      if (file.type === 'text/html' || file.name.endsWith('.html')) {
        const text = await file.text();
        const imported = extractDiagnosticResultFromHtmlReport(text);
        if (imported.kind === 'report') {
          setPreparedResult(imported.result, 'html_import');
          setViewMode('dashboard');
          setRecoveryNotice('Imported a saved FinOps report from HTML.');
          return;
        }
        if (imported.kind === 'display_only_report') {
          setError('This HTML report is display-only and cannot restore an assessment. Download and upload the assessment JSON instead.');
          return;
        }
        if (imported.kind === 'invalid_report') {
          setError(imported.error);
          return;
        }
      } else if (file.type === 'application/json' || file.name.endsWith('.json')) {
        try {
          const text = await file.text();
          const imported = parseDiagnosticResultJson(text);
          if (imported.kind === 'report' && isDiagnosticResultPayload(imported.result)) {
            setPreparedResult(imported.result, 'json_import');
            setViewMode('dashboard');
            setRecoveryNotice('Imported a saved FinOps report from JSON.');
            return;
          }
          if (imported.kind === 'invalid_report') {
            setError(imported.error);
            return;
          }
        } catch (e) { console.error("Failed to parse JSON file (error_code=JSON_IMPORT_FAILED); filename and error content omitted."); }
      }
    }

    if (result) {
      setError('A completed assessment is currently open. Use Reset Session before uploading new source material; the current report is preserved.');
      return;
    }

    if (files.length + newFiles.length > MAX_FILES) {
      setError(`Maximum ${MAX_FILES} documents allowed.`);
      return;
    }

    const totalUploadBytes = files.reduce((sum, file) => sum + file.size, 0) + newFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
      setError(`Maximum ${MAX_TOTAL_UPLOAD_MB} MB total upload set allowed.`);
      return;
    }

    const processedFiles: UploadedFile[] = [];
    const rejectedFiles: Array<{ name: string; code: string }> = [];
    for (const file of newFiles) {
      try {
        const parsed = await parseEvidenceFile(file);
        processedFiles.push({
          ...parsed,
          id: Math.random().toString(36).substr(2, 9),
          status: 'parsed',
          scan: scanParseableFile(parsed.text, parsed.kind, false),
        });
      } catch (error) {
        rejectedFiles.push({ name: file.name, code: acquisitionErrorCode(error) });
      }
    }
    if (processedFiles.length > 0) {
      setFiles(prev => [...prev, ...processedFiles]);
    }
    if (rejectedFiles.length > 0) {
      setError(`Rejected ${rejectedFiles.length} file(s): ${rejectedFiles.map(file => `${file.name} (${file.code})`).join('; ')}. Other valid files were retained.`);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (parsing || !event.target.files?.length) return;
    const newFiles = Array.from(event.target.files);
    const oversizedFile = newFiles.find(file => file.size > MAX_FILE_SIZE_BYTES);
    if (oversizedFile) {
      setError(`${oversizedFile.name} exceeds the ${MAX_FILE_SIZE_MB} MB per-file limit.`);
      clearFileInput();
      return;
    }

    setParsing(true);
    setError(null);
    try {
      await processSelectedFiles(newFiles);
    } catch {
      setError('Could not read the selected files.');
    } finally {
      setParsing(false);
      clearFileInput();
    }
  };

  const removeFile = (id: string) => setFiles(files.filter(f => f.id !== id));

  const runAnalyze = async () => {
    setLoading(true);
    setPipelineProgress({});
    setCompletedDomains([]);
    setError(null);
    PerformanceMonitor.start('FullAnalysis');
    try {
      const sources = toEvidenceSourceRecords(files);
      const data = await analyzeDocument(sources, update => {
        setPipelineProgress(current => ({ ...current, [update.stage]: update }));
        if (update.stage === 'analysis' && update.domain_id) {
          setCompletedDomains(current => current.includes(update.domain_id!) ? current : [...current, update.domain_id!]);
        }
      }, {
        deepMode,
        onRunStarted: runId => {
          if (typeof window !== 'undefined') window.localStorage.setItem(ACTIVE_RUN_KEY, runId);
        }
      });
      if (!data.phase_2_validation?.metrics) throw new Error("Analysis returned incomplete data.");
      const source_parse_warnings = [...new Set([
        ...(data.meta.source_parse_warnings || []),
        ...sourceParseWarningsForFiles(files)
      ])];
      if (source_parse_warnings.length > 0) {
        data.meta = { ...data.meta, source_parse_warnings };
      }
      saveAssessmentToSession(data, 'completed_assessment');
      setPreparedResult(data, 'completed_assessment');
      if (data.meta.run_id) {
        try {
          await acknowledgeRun(data.meta.run_id);
          if (typeof window !== 'undefined') window.localStorage.removeItem(ACTIVE_RUN_KEY);
        } catch {
          setRecoveryNotice('The report is safely stored in this browser, but backend delivery acknowledgement is pending and will be retried by expiry cleanup.');
        }
      }
    } catch (e: any) {
      setError(e.message || "Analysis failed.");
    } finally {
      setLoading(false);
      PerformanceMonitor.end('FullAnalysis');
    }
  };

  const handleAnalyze = async () => {
    if (!aggregatedText || !scanResult.canRun) return;
    if (!authenticated) {
      pendingAnalyzeRef.current = true;
      setShowLogin(true);
      return;
    }
    await runAnalyze();
  };

  const reset = () => {
    const runId = result?.meta?.run_id || safeRecoveryResult?.meta?.run_id || readSavedAssessment()?.meta?.run_id;
    if (runId) void deleteRun(runId).catch(() => setRecoveryNotice('Browser data was cleared; backend deletion will be retried by expiry cleanup.'));
    setResult(null);
    setFiles([]);
    setAggregatedText('');
    setError(null);
    setPipelineProgress({});
    setCompletedDomains([]);
    setActiveTab('overview');
    setViewMode('dashboard');
    setRecoveryNotice(null);
    setSafeRecoveryResult(null);
    setSafeRecoveryMeta(null);
    setLastCrashMessage(null);
    setHasSavedAssessment(false);
    setPrivacyPanelOpen(false);
    setPrivacyEdited(false);
    setPrivacyNotice(null);
    setOrganizationRedactionTerm('');
    clearSavedAssessment();
    if (typeof window !== 'undefined') window.localStorage.removeItem(ACTIVE_RUN_KEY);
  };

  const restoreSavedAssessment = () => {
    const saved = readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      setError('No saved assessment was found in this browser session.');
      return;
    }
    setSafeRecoveryResult(saved);
    setSafeRecoveryMeta(readSavedAssessmentMeta());
    setLastCrashMessage(readLastCrash());
    setResult(null);
    setViewMode('dashboard');
    setActiveTab('overview');
    setRecoveryNotice('Opened recovery mode for the last completed assessment. You can download reports before retrying the dashboard.');
    if (findGeneratedReportPrivacyFindings(saved).length > 0) {
      setPrivacyNotice('Potential names detected in generated report text. Review before sharing.');
    }
    setError(null);
    setHasSavedAssessment(true);
    setErrorBoundaryResetKey(key => key + 1);
  };

  const clearSavedAssessmentAndRestart = () => {
    // reset captures the saved/recovery run before browser storage is removed.
    setHasSavedAssessment(false);
    setRecoveryNotice(null);
    setSafeRecoveryResult(null);
    setSafeRecoveryMeta(null);
    setLastCrashMessage(null);
    reset();
  };

  const downloadResultJson = (saved: DiagnosticResult | null) => {
    if (!saved) {
      setHasSavedAssessment(false);
      return;
    }
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FinOps_Recovered_Assessment_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSavedAssessment = () => {
    downloadResultJson(safeRecoveryResult || readSavedAssessment());
  };

  const openRecoveredDashboard = () => {
    if (!safeRecoveryResult) return;
    setResult(safeRecoveryResult);
    setSafeRecoveryResult(null);
    setSafeRecoveryMeta(null);
    setLastCrashMessage(null);
    clearLastCrash();
    setViewMode('dashboard');
    setActiveTab('overview');
    setRecoveryNotice('Recovered assessment opened. If the view fails again, use recovery mode to download the report.');
    if (findGeneratedReportPrivacyFindings(safeRecoveryResult).length > 0) {
      setPrivacyNotice('Potential names detected in generated report text. Review before sharing.');
    }
    setErrorBoundaryResetKey(key => key + 1);
  };

  const downloadRecoveredSummaryReport = () => {
    const saved = safeRecoveryResult || readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      return;
    }
    downloadSummaryReport(saved);
  };

  const downloadRecoveredMasterReport = () => {
    const saved = safeRecoveryResult || readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      return;
    }
    downloadMasterDataReport(saved);
  };

  const downloadRecoveredRunTrace = () => {
    const saved = safeRecoveryResult || readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      return;
    }
    downloadRunTraceJson(saved);
  };

  const recordUiCrash = (error: Error, info: React.ErrorInfo) => {
    const message = error?.message || 'Unknown render error';
    saveLastCrash(message, info.componentStack || undefined);
    setLastCrashMessage(message);
    setHasSavedAssessment(Boolean(readSavedAssessment()));
  };

  const showReference = !result && activeTab === 'reference';

  if (safeRecoveryResult) {
    const savedAt = safeRecoveryMeta?.savedAt ? new Date(safeRecoveryMeta.savedAt).toLocaleString() : 'this browser session';
    const source = safeRecoveryMeta?.source?.replace(/_/g, ' ') || 'saved assessment';
    const analyzed = safeRecoveryMeta?.documentAnalyzed || safeRecoveryResult.meta?.document_analyzed || 'Recovered assessment';
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-6 py-12">
        <div className="max-w-3xl w-full rounded-3xl border border-white/10 bg-slate-900 p-8 md:p-10 shadow-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-300 mb-3">Assessment Recovery</p>
          <h1 className="text-3xl md:text-4xl font-display font-black mb-4">Your assessment data is still available.</h1>
          <p className="text-slate-300 leading-relaxed">
            This safe view avoids rendering the dashboard or report components that may have crashed. Download the recovered files first, then retry the dashboard when you are ready.
          </p>
          <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/60 p-5 text-sm text-slate-300 space-y-2">
            <div><span className="text-slate-500 font-bold uppercase tracking-wider text-xs">Source:</span> {source}</div>
            <div><span className="text-slate-500 font-bold uppercase tracking-wider text-xs">Saved:</span> {savedAt}</div>
            <div><span className="text-slate-500 font-bold uppercase tracking-wider text-xs">Assessment:</span> {analyzed}</div>
            {lastCrashMessage && (
              <div className="pt-2 text-amber-200">
                <span className="text-amber-400 font-bold uppercase tracking-wider text-xs">Last render error:</span> {lastCrashMessage}
              </div>
            )}
          </div>
          {authenticated && (
            <div className="mt-6"><GoldenStandardStatus check={openingRetrievalCheck} deepMode={deepMode} /></div>
          )}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={downloadRecoveredSummaryReport}
              className="px-5 py-3 rounded-xl font-bold bg-emerald-400 text-slate-950 hover:bg-emerald-300 transition-colors"
            >
              Download Summary Report
            </button>
            <button
              type="button"
              onClick={downloadRecoveredMasterReport}
              className="px-5 py-3 rounded-xl font-bold bg-white text-slate-950 hover:bg-emerald-50 transition-colors"
            >
              Download Master Data Report
            </button>
            <button
              type="button"
              onClick={() => downloadResultJson(safeRecoveryResult)}
              className="px-5 py-3 rounded-xl font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors"
            >
              Download Recovered JSON
            </button>
            {safeRecoveryResult.meta.run_trace && (
              <button
                type="button"
                onClick={downloadRecoveredRunTrace}
                className="px-5 py-3 rounded-xl font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors"
              >
                Download RunTrace JSON
              </button>
            )}
            <button
              type="button"
              onClick={openRecoveredDashboard}
              className="px-5 py-3 rounded-xl font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors"
            >
              Open Dashboard
            </button>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                setSafeRecoveryResult(null);
                setSafeRecoveryMeta(null);
                setLastCrashMessage(null);
                clearLastCrash();
                setErrorBoundaryResetKey(key => key + 1);
              }}
              className="text-sm font-bold text-slate-400 hover:text-white transition-colors"
            >
              Return to start screen
            </button>
            <button
              type="button"
              onClick={clearSavedAssessmentAndRestart}
              className="text-sm font-bold text-rose-300 hover:text-rose-200 transition-colors"
            >
              Clear saved assessment
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (result && viewMode === 'report') {
    return (
      <AppErrorBoundary
        hasSavedAssessment={hasSavedAssessment}
        resetKey={errorBoundaryResetKey}
        onRestoreSaved={restoreSavedAssessment}
        onDownloadSaved={downloadSavedAssessment}
        onClearSaved={clearSavedAssessmentAndRestart}
        onError={recordUiCrash}
      >
        <ReportView
          result={result}
          onBack={() => setViewMode('dashboard')}
          onDownloadSummary={() => downloadSummaryReport(result)}
          onDownloadMaster={() => downloadMasterDataReport(result)}
          onDownloadJson={() => downloadAssessmentJson(result)}
          onDownloadTrace={() => downloadRunTraceJson(result)}
        />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary
      hasSavedAssessment={hasSavedAssessment}
      resetKey={errorBoundaryResetKey}
      onRestoreSaved={restoreSavedAssessment}
      onDownloadSaved={downloadSavedAssessment}
      onClearSaved={clearSavedAssessmentAndRestart}
      onError={recordUiCrash}
    >
    <div className={`relative flex min-h-screen flex-col overflow-x-clip font-sans ${result ? 'bg-slate-900' : 'bg-finops-canvas text-finops-ink'}`}>
      <header className="sticky top-0 z-40 border-b border-finops-line bg-finops-surface text-finops-ink">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <button type="button" onClick={() => setActiveTab('overview')} className="flex items-center gap-3 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-finops-forest">
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-finops-forest text-sm font-black text-finops-lime">FO</span>
            <span className="leading-tight">
              <span className="finops-kicker block">Governed assessment</span>
              <span className="block text-sm font-bold tracking-tight">{APP_VERSION_LABEL}</span>
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-finops-line px-3 py-1.5 text-xs font-medium text-finops-muted lg:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-finops-forest" aria-hidden="true" />
              System Online
            </div>

            <button
              onClick={async () => {
                if (authenticated) {
                  await logout();
                  setAuthenticated(false);
                } else {
                  pendingAnalyzeRef.current = false;
                  setShowLogin(true);
                }
              }}
              type="button"
              className="finops-button"
              aria-label={authenticated ? 'Log out' : 'Log in'}
            >
              <span aria-hidden="true">{authenticated ? '🔓' : '🔒'}</span>
              <span>{authenticated ? 'Unlocked' : 'Locked'}</span>
            </button>

            <a
              href={result ? '/user-guide.html#gauges' : '/user-guide.html'}
              target="_blank"
              rel="noopener noreferrer"
              className="finops-button"
            >
              User Guide
            </a>

            {!result && (
              <button type="button" onClick={() => setActiveTab(activeTab === 'reference' ? 'overview' : 'reference')} className="finops-button">
                {activeTab === 'reference' ? 'Close Reference' : 'View Criteria'}
              </button>
            )}

            {(result || files.length > 0) && (
              <button type="button" onClick={reset} disabled={loading} className="finops-button">
                <span aria-hidden="true">&#8635;</span>
                {loading ? 'Analyzing...' : 'Reset Session'}
              </button>
            )}
          </div>
        </div>
      </header>

      {recoveryNotice && (
        <div className="finops-card relative z-30 mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-[74rem] flex-col gap-3 bg-finops-sage px-5 py-3 text-sm md:flex-row md:items-center md:justify-between">
          <span>{recoveryNotice}</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRecoveryNotice(null)}
              className="finops-button"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                clearSavedAssessment();
                setHasSavedAssessment(false);
                setRecoveryNotice(null);
              }}
              className="finops-button"
            >
              Clear saved assessment
            </button>
          </div>
        </div>
      )}

      <main className="relative z-20 mx-auto w-full max-w-[77rem] flex-grow space-y-5 px-4 py-8 sm:px-6 sm:py-12">
        {!result && !showReference && (
          <div>
            {!loading ? (
              <>
                <section aria-labelledby="intake-title" className="mb-8 grid items-end gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-12">
                  <div>
                    <p className="finops-kicker">Evidence-led FinOps assessment</p>
                    <h1 id="intake-title" className="mt-3 max-w-[12ch] text-4xl font-black leading-[1.02] tracking-[-0.05em] sm:text-6xl">FinOps Assessment Engine</h1>
                    <p className="mt-4 max-w-2xl text-base leading-relaxed text-finops-muted">
                      Assess FinOps documentation against <strong className="font-semibold text-finops-ink">30 maturity vectors and 30 anti-pattern indicators</strong> to determine your Crawl–Walk–Run classification.
                    </p>
                  </div>
                  <aside className="flex items-start gap-3 rounded-xl border border-finops-note-line bg-finops-note p-4">
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-finops-forest text-sm font-bold text-finops-lime">i</span>
                    <div>
                      <h2 className="text-sm font-bold">Before you start &amp; data handling</h2>
                      <p className="mt-1 text-xs leading-relaxed text-amber-950">
                        New to the assessment workflow?{' '}
                        <a href="/user-guide.html" target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                          Read the User Guide
                        </a>
                        {' · '}
                        <a href="/data-handling.html" target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                          See how assessment data is handled
                        </a>.
                      </p>
                    </div>
                  </aside>
                </section>

                <section aria-labelledby="upload-title" className="finops-card p-5 sm:p-7">
                  <div className="mb-5">
                    <p className="finops-kicker">Evidence intake</p>
                    <h2 id="upload-title" className="mt-1 text-xl font-bold tracking-tight">Upload FinOps evidence</h2>
                  </div>
                  <div>
                    {files.length > 0 ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        {files.map((file) => (
                          <div key={file.id} className={`flex min-w-0 items-center justify-between gap-2 rounded-xl border p-3 ${file.scan?.status === 'Insufficient' ? 'border-rose-200 bg-rose-50' : 'border-finops-line bg-finops-soft'}`}>
                            <div className="flex min-w-0 items-center gap-3">
                              <div aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${file.scan?.status === 'Insufficient' ? 'bg-rose-100' : 'bg-finops-sage'}`}>
                                {file.scan?.status === 'Insufficient' ? '⚠️' : '📄'}
                              </div>
                              <div className="min-w-0">
                                <div title={file.name} className={`truncate text-sm font-bold ${file.scan?.status === 'Insufficient' ? 'text-rose-800' : 'text-finops-ink'}`}>{file.name}</div>
                                <div className="mt-0.5 flex items-center gap-2">
                                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${file.scan?.status === 'Insufficient' ? 'bg-rose-600' : file.scan?.status === 'Weak' || file.scan?.status === 'PassWithWarning' ? 'bg-amber-600' : 'bg-finops-forest'}`} />
                                  <div className="text-xs font-medium text-finops-muted">
                                    {file.scan?.status === 'Insufficient' ? 'Unreadable / Empty' : file.scan?.status === 'PassWithWarning' ? 'Low Relevance Warning' : file.scan?.status === 'Weak' ? 'Weak Signal' : 'Ready'} &bull; {(file.size / 1024).toFixed(0)} KB
                                  </div>
                                </div>
                                {file.parseMetadata && (
                                  <div className="mt-1 truncate text-xs text-finops-muted">
                                    {file.kind === 'pdf' && `${file.parseMetadata.parsedTextPages}/${file.parseMetadata.totalPages} pages acquired · ${file.parseMetadata.parseQuality?.visualPagesIncluded || 0} locally OCR'd`}
                                    {(file.kind === 'csv' || file.kind === 'tsv') && `${file.parseMetadata.rowCount} table rows parsed`}
                                    {file.parseMetadata.warnings.length > 0 && ` · ${file.parseMetadata.warnings[0]}`}
                                  </div>
                                )}
                                {file.parseMetadata?.parseQuality && (
                                  <div className={`text-[10px] mt-1 font-bold uppercase tracking-wide ${
                                    file.parseMetadata.parseQuality.quality === 'poor'
                                      ? 'text-rose-800'
                                      : file.parseMetadata.parseQuality.quality === 'mixed'
                                        ? 'text-amber-900'
                                        : 'text-finops-forest'
                                  }`}>
                                    {parseQualityLabel(file.parseMetadata.parseQuality.quality)}
                                  </div>
                                )}
                              </div>
                            </div>
                            <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(file.id)} className="finops-button shrink-0 px-3">&times;</button>
                          </div>
                        ))}
                        {parsing && (
                          <p role="status" className="rounded-xl border border-dashed border-finops-outline bg-finops-soft p-4 text-sm font-semibold text-finops-forest">Extracting text...</p>
                        )}
                      </div>
                    ) : (
                      <div
                        onClick={() => !parsing && fileInputRef.current?.click()}
                        className="cursor-pointer rounded-xl border-2 border-dashed border-finops-intake-line bg-finops-intake p-4 text-finops-ink transition-colors hover:bg-finops-intake-hover sm:p-5"
                      >
                        <p className="text-sm font-medium leading-relaxed text-finops-ink">Add cloud cost reports, FinOps policies, optimization plans, governance documents, or architecture reviews.</p>
                        <ul aria-label="Example supported file formats" className="mt-3 flex flex-wrap gap-1.5">
                          {['PDF', 'HTML', 'CSV', 'TSV', 'XLSX', 'PNG/JPEG', 'JSON'].map(fmt => (
                            <li key={fmt} className="rounded-md border border-finops-intake-line/50 bg-finops-surface px-2 py-1 text-[11px] font-semibold text-finops-forest">{fmt}</li>
                          ))}
                        </ul>
                        <p className="mt-3 text-xs leading-relaxed text-finops-forest/90">
                          {MIN_FILES}–{MAX_FILES} artifacts · {MAX_TOTAL_UPLOAD_MB} MB total · {MAX_FILE_SIZE_MB} MB per file · PDFs parsed as extracted text up to 100 pages
                        </p>
                        {parsing && <p role="status" className="mt-3 text-sm font-semibold text-finops-forest">Extracting text...</p>}
                      </div>
                    )}
                  </div>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-finops-line pt-4">
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                      <button type="button" onClick={() => fileInputRef.current?.click()} disabled={parsing || files.length >= MAX_FILES} className="finops-button">
                        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                        Add Files
                      </button>
                      <label
                        title="Uses the deeper synthesis route for roadmap reasoning. It can be slower and is also selected automatically for assessments that meet escalation rules."
                        className="flex cursor-pointer items-center gap-2 rounded-lg py-2 text-sm font-semibold text-finops-muted"
                      >
                        <input
                          type="checkbox"
                          checked={deepMode}
                          onChange={(e) => setDeepMode(e.target.checked)}
                          className="cursor-pointer accent-finops-forest"
                        />
                        <span>Deep analysis</span>
                      </label>
                    </div>
                    <input type="file" ref={fileInputRef} onChange={handleFileSelect} disabled={parsing} className="hidden" accept=".pdf,.html,.csv,.tsv,.xlsx,.png,.jpg,.jpeg,.webp,.json,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp" multiple />
                    <button type="button" onClick={handleAnalyze} disabled={!scanResult.canRun || files.length < MIN_FILES || files.length > MAX_FILES} className="finops-primary">
                      {!scanResult.canRun || files.length < MIN_FILES || files.length > MAX_FILES ? (
                        <span>{files.length < MIN_FILES ? `Add ${MIN_FILES - files.length} more files` : files.length > MAX_FILES ? "Limit Exceeded" : "Checks Failed"}</span>
                      ) : (
                        <>
                          <span>Run FinOps Assessment</span>
                          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                        </>
                      )}
                    </button>
                  </div>
                </section>

                {error && (
                  <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                    <p className="font-bold">Error</p>
                    <p>{error}</p>
                  </div>
                )}

                <PrivacyProtocolCard />
              </>
            ) : (
              <NeuralLoadingGrid progress={pipelineProgress} completedDomains={completedDomains} />
            )}
          </div>
        )}

        {authenticated && <GoldenStandardStatus check={openingRetrievalCheck} deepMode={deepMode} />}

        {result && viewMode === 'dashboard' && (
          <div className="animate-fade-in space-y-12 mb-20">
            <div className="flex justify-center mb-8">
              <div className="glass-panel flex flex-wrap justify-center gap-1 rounded-2xl bg-slate-900/60 p-1.5">
                {[
                  { id: 'overview', label: 'Summary & Diagnosis' },
                  { id: 'audit', label: 'Forensic Audit' },
                  { id: 'strategy', label: 'Optimization Roadmap' }
                ].map(tab => (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} className={`px-4 py-3 sm:px-8 rounded-xl text-sm font-bold transition-all duration-300 ${activeTab === tab.id ? 'bg-white text-slate-900 shadow-lg' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>{tab.label}</button>
                ))}
              </div>
            </div>

            {activeTab === 'overview' && (
              <div className="animate-fade-in space-y-8">
                <div className="glass-panel p-10 md:p-14 rounded-[2rem] hover:bg-slate-900/60 transition-all duration-500">
                  <div className="flex items-start gap-6 mb-8">
                    <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold font-display text-lg shadow-[0_0_15px_rgba(16,185,129,0.2)] flex-shrink-0">01</div>
                    <div>
                      <h3 className="text-2xl font-display font-bold text-white mb-2">Evidence Summary</h3>
                      <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                        Classification: <span className={`${result.phase_2_validation.crawl_walk_run.includes('Insufficient') || result.phase_2_validation.crawl_walk_run.includes('Crawl') ? 'text-rose-400' : result.phase_2_validation.crawl_walk_run.includes('Run') ? 'text-emerald-400' : 'text-amber-400'}`}>{result.phase_2_validation.crawl_walk_run}</span>
                      </p>
                    </div>
                  </div>
                  <div className="pl-4 md:pl-20 border-l-2 border-emerald-500/20">
                    <div className="mb-6 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mr-2">Persona Lens:</span>
                      {PERSONA_IDS.map(p => (
                        <button
                          key={p}
                          onClick={() => setActivePersona(p)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ${activePersona === p ? 'bg-emerald-500 text-slate-900 shadow-[0_0_15px_rgba(16,185,129,0.4)]' : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10'}`}
                        >
                          {PERSONA_LABELS[p]}
                        </button>
                      ))}
                    </div>
                    <MarkdownRenderer content={createReportNarrative(result)(result.phase_3_strategy.executive_summaries?.[activePersona] || result.phase_3_strategy.executive_summary).text} />
                    {result.phase_3_strategy.evidence_summary && (
                      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {result.phase_3_strategy.evidence_summary.key_metrics?.map((metric, i) => (
                          <div key={i} className="p-3 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300">{metric}</div>
                        ))}
                      </div>
                    )}
                    {(() => {
                      const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
                      const personaClaims = claims.filter(c => c.source_location === activePersona);
                      if (personaClaims.length === 0) return null;
                      return (
                        <div className="mt-6 p-5 rounded-xl bg-amber-500/10 border border-amber-500/30">
                          <div className="flex items-center gap-2 mb-3">
                            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3l-7.07-12a2 2 0 00-3.48 0L3.2 16a2 2 0 001.73 3z" /></svg>
                            <span className="text-xs font-bold uppercase tracking-widest text-amber-300">Confidence Notes — Unverified Claims</span>
                          </div>
                          <p className="text-xs text-amber-100/80 mb-3">The following statements in this summary could not be verified against your source after {result.quality_gate?.fact_check?.attempts || 0} regenerate pass(es). Treat with caution.</p>
                          <ul className="space-y-2">
                            {personaClaims.map((c, i) => (
                              <li key={i} className="text-sm text-amber-50">
                                <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                                <span className="block text-xs text-amber-200/70 mt-0.5">{c.rationale}{c.failure_type ? ` · ${c.failure_type.replace(/_/g, ' ')}` : ''}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                  <TransferProtocol />
                  <div className="mt-8 rounded-2xl border border-emerald-500/20 bg-emerald-950/20 p-5">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">Privacy Review</p>
                          {privacyEdited && <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-bold uppercase tracking-widest text-emerald-200">Edited locally</span>}
                        </div>
                        <p className="text-sm text-slate-300">
          Review generated wording before sharing. Manual edits and redactions are applied to the dashboard and exported HTML and JSON files.
                        </p>
                        {privacyNotice && <p className="mt-2 text-xs text-amber-200">{privacyNotice}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => setPrivacyPanelOpen(open => !open)}
                        className="px-5 py-3 rounded-xl bg-slate-900 text-emerald-200 border border-emerald-500/30 text-xs font-bold uppercase tracking-widest hover:bg-emerald-500 hover:text-slate-950 transition-colors"
                      >
                        {privacyPanelOpen ? 'Close editor' : 'Privacy Review / Edit Report'}
                      </button>
                    </div>
                  </div>
                  {privacyPanelOpen && (
                    <div className="mt-6">
                      <PrivacyReviewPanel
                        result={result}
                        edited={privacyEdited}
                        notice={privacyNotice}
                        organizationRedactionTerm={organizationRedactionTerm}
                        onOrganizationRedactionTermChange={setOrganizationRedactionTerm}
                        onApplyPersonRedaction={applyPersonRedaction}
                        onApplyOrganizationRedaction={applyOrganizationRedaction}
                        onPreview={() => setViewMode('report')}
                        onChange={updateCurrentResult}
                      />
                    </div>
                  )}
                  <div className="mt-12 flex flex-col md:flex-row justify-center items-center gap-6 w-full">
                    <button onClick={() => setViewMode('report')} className="group relative px-8 py-4 rounded-2xl bg-white hover:bg-emerald-50 border border-white shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(16,185,129,0.4)] transition-all duration-300">
                      <div className="relative flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-inner group-hover:bg-emerald-500 transition-colors">
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        </div>
                        <div className="text-left">
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 group-hover:text-emerald-600">Final Artifact</span>
                          <span className="block text-sm font-bold text-slate-900">Review & Download Report</span>
                        </div>
                      </div>
                    </button>
                    {result.meta.run_trace && (
                      <button onClick={() => downloadRunTraceJson(result)} className="group relative px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-white/10 shadow-[0_0_20px_rgba(15,23,42,0.2)] transition-all duration-300">
                        <div className="relative flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-300 flex items-center justify-center border border-emerald-500/30 group-hover:bg-emerald-500 group-hover:text-slate-950 transition-colors">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707v13a2 2 0 01-2 2z" /></svg>
                          </div>
                          <div className="text-left">
                            <span className="block text-[10px] font-bold uppercase tracking-widest text-emerald-300">Provenance</span>
                            <span className="block text-sm font-bold text-white">Download RunTrace JSON</span>
                          </div>
                        </div>
                      </button>
                    )}
                  </div>
                </div>

                <QualityGateBanner gate={result.quality_gate} />

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
                    <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-amber-500/20">
                      <div className="flex items-start gap-4 mb-5">
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold text-sm flex-shrink-0">!</div>
                        <div>
                          <h3 className="text-lg font-display font-bold text-white">Source Coverage Gaps</h3>
                          <p className="text-xs text-slate-400 mt-1">To strengthen the next assessment cycle, include the following kinds of evidence in the source document.</p>
                        </div>
                      </div>
                      <div className="space-y-4 pl-14">
                        {Object.entries(byType).map(([type, materials]) => (
                          <div key={type}>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300 mb-2">{type}</p>
                            <ul className="space-y-1.5">
                              {Array.from(new Set(materials)).map((m, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                                  <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-400 shrink-0"></span>
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

                {result.phase_3_strategy.diagnosis && (() => {
                  const formatDashboardNarrative = createReportNarrative(result);
                  const diag = result.phase_3_strategy.diagnosis;
                  return (
                  <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-white/10">
                    <div className="flex items-start gap-4 mb-5">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-bold text-sm flex-shrink-0">02</div>
                      <div>
                        <h3 className="text-lg font-display font-bold text-white">Diagnosis</h3>
                        <p className="text-xs text-slate-400 mt-1">Interpretation of the evidence. Recommendations remain separated in the roadmap tab.</p>
                      </div>
                    </div>
                    <div className="pl-14 space-y-5">
                      {diag.executive_summary?.trim() && (
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300 mb-2">Executive summary</p>
                          <p className="text-sm text-slate-200 leading-relaxed">{formatDashboardNarrative(diag.executive_summary).text}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 mb-2">Primary bottleneck</p>
                        <p className="text-sm text-slate-200 leading-relaxed">{formatDashboardNarrative(diag.primary_bottleneck).text}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 mb-2">Root causes</p>
                        <ul className="space-y-1.5">
                          {diag.root_causes?.map((cause, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-slate-300"><span className="mt-1.5 w-1 h-1 rounded-full bg-cyan-400 shrink-0"></span><span>{formatDashboardNarrative(cause).text}</span></li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                  );
                })()}

                {result.phase_3_strategy.planning_decision && (
                  <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-emerald-500/20">
                    <div className="flex items-start gap-4 mb-5">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-sm flex-shrink-0">03</div>
                      <div>
                        <h3 className="text-lg font-display font-bold text-white">Planning Decision: {result.phase_3_strategy.planning_decision.decision?.replace('_', ' ')}</h3>
                        <p className="text-xs text-slate-400 mt-1">{createReportNarrative(result)(result.phase_3_strategy.planning_decision.rationale || '').text}</p>
                      </div>
                    </div>
                  </div>
                )}


                {(() => {
                  const reportView = buildReportViewModel(result);
                  return <>
                    <div className={`rounded-2xl border p-5 ${reportView.sufficiency.decision === 'PASS' ? 'border-emerald-500/30 bg-emerald-950/20' : 'border-amber-500/30 bg-amber-950/20'}`}>
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-300">Assessment Sufficiency: {reportView.sufficiency.decision}</p>
                      <p className="mt-1 text-sm text-slate-400">{reportView.sufficiency.statement}</p>
                      {reportView.sufficiency.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">{reportView.sufficiency.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
                      {reportView.sufficiency.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">{reportView.sufficiency.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {reportView.metrics.map(metric => (
                    <div key={metric.label} className="md:col-span-1">
                      <GaugeCard
                        value={metric.value}
                        label={metric.label}
                        color={metric.color}
                        trend={metric.trend}
                        subLabel={metric.denominator}
                        description={metric.description}
                      />
                    </div>
                  ))}
                    </div>
                  </>;
                })()}

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 h-full items-stretch">
                  <div className="h-full lg:col-span-3">
                    <BenchmarkingChart
                      x={result.phase_2_validation.metrics.maturity_depth}
                      y={result.phase_2_validation.metrics.antipattern_burden}
                      evidenceDensity={result.phase_2_validation.metrics.evidence_density}
                      antipatternCoverage={result.phase_2_validation.metrics.antipattern_coverage}
                      qualityGateDecision={result.quality_gate.decision}
                    />
                  </div>
                  <div className="glass-panel p-8 rounded-[2rem] bg-slate-900/50 flex flex-col lg:col-span-2 border-white/5">
                    <h3 className="text-xl font-display font-bold text-white mb-6">Domain Balance</h3>
                    <div className="flex-1 min-h-[300px]">
                      <ComparisonChart maturity={result.phase_1_audit_logs.maturity} antipattern={result.phase_1_audit_logs.antipattern} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'audit' && (
              <div className="animate-fade-in grid grid-cols-1 gap-8">
                <AuditGrid title="FinOps Maturity Audit" data={result.phase_1_audit_logs.maturity} isAntipattern={false} />
                <AuditGrid title="Anti-Pattern Detection" data={result.phase_1_audit_logs.antipattern} isAntipattern={true} />
              </div>
            )}

            {activeTab === 'strategy' && (
              <div className="animate-fade-in">
                {!result.phase_3_strategy.remediation_roadmap.length ? (
                  <div className="text-center py-24 glass-panel rounded-[3rem]">
                    <h3 className="text-2xl font-bold text-slate-400">Strategy Aborted</h3>
                    <p className="text-slate-500 mt-2">Insufficient data to generate roadmap.</p>
                  </div>
                ) : (
                  <div className="glass-panel p-10 md:p-16 rounded-[3rem] bg-slate-900/40">
                    <div className="text-center mb-16 max-w-2xl mx-auto">
                      <span className="text-xs font-bold uppercase tracking-widest text-emerald-400 mb-3 block">Phase 3</span>
                      <h2 className="text-4xl font-display font-bold text-white mb-4">Optimization Roadmap</h2>
                      <p className="text-slate-400">A structured Crawl-Walk-Run path to FinOps excellence.</p>
                    </div>
                    <StrategicRoadmap steps={result.phase_3_strategy.remediation_roadmap} formatText={createReportNarrative(result)} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showReference && <ReferenceLibrary />}
      </main>

      <footer className="relative z-10 mt-auto border-t border-finops-line bg-finops-surface text-finops-ink">
        <div className="mx-auto flex max-w-[77rem] flex-wrap items-center justify-between gap-5 px-4 py-6 sm:px-6">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-finops-forest text-xs font-black text-finops-lime">FO</span>
            <p className="text-xs leading-relaxed text-finops-muted">
              <strong className="text-finops-ink">{APP_VERSION_LABEL}</strong><br />Governed multi-stage architecture
            </p>
          </div>

          <div className="rounded-full border border-finops-line px-3 py-1.5 text-xs font-medium text-finops-muted">
            Provider-Backed Processing
          </div>
        </div>
      </footer>

      <LoginModal
        open={showLogin}
        onClose={() => {
          setShowLogin(false);
          pendingAnalyzeRef.current = false;
        }}
        onSuccess={() => {
          setShowLogin(false);
          setAuthenticated(true);
          if (pendingAnalyzeRef.current) {
            pendingAnalyzeRef.current = false;
            runAnalyze();
          }
        }}
      />
    </div>
    </AppErrorBoundary>
  );
};

export default App;
