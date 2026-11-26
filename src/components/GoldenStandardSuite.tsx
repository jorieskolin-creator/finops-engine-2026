import { useEffect, useRef, useState } from 'react';
import { getModelRoutingConfig } from '../services/modelRouter';
import type { Comparison, Disposition, NarrativeReview } from '../monitoring/clearBlockNarrativeReview';
import {
  attemptStatus,
  caseIds,
  caseNames,
  digest,
  GoldenStandardClientError,
  loadSuiteHistory,
  repeatability,
  suiteCommand,
  suiteStatus,
  summarizeMonitoringDashboard,
  type CaseId,
  type Selection,
  type Suite,
  type SuiteAttempt,
  type SuiteReport,
} from '../monitoring/goldenStandardSuite';
import { ClearBlockReview } from './ClearBlockGoldenStandard';

const reportStorage = 'finops:golden-standard:latest-reports:v1';
const maxCachedSessionReports = 15;

function loadReports(): Record<string, SuiteReport> {
  try { return JSON.parse(sessionStorage.getItem(reportStorage) ?? '{}'); }
  catch { return {}; }
}

function saveReports(reports: Record<string, SuiteReport>) {
  try {
    const entries = Object.entries(reports);
    const trimmed = entries.length > maxCachedSessionReports
      ? Object.fromEntries(entries.slice(entries.length - maxCachedSessionReports))
      : reports;
    sessionStorage.setItem(reportStorage, JSON.stringify(trimmed));
  } catch {
    /* The current panel still displays reports from memory and PostgreSQL. */
  }
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function buildFallbackSummaryHtml(attempt: SuiteAttempt): string {
  const summary = attempt.summary;
  const comp = attempt.comparison;
  const listHtml = (items: string[]) => items.length
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>None recorded.</p>';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>Golden Standard Summary · ${escapeHtml(caseNames[attempt.case_id])}</title>`,
    '<style>body{font:15px/1.55 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1e312a;background:#fcfcf7}h1,h2,h3{color:#203a30}section{margin:20px 0;padding:16px;border:1px solid #d7ded4;border-radius:12px;background:#fff}ul{padding-left:20px}</style>',
    '</head><body>',
    `<h1>Golden Standard Summary · ${escapeHtml(caseNames[attempt.case_id])} (Run ${attempt.repetition})</h1>`,
    `<p>Run ID: ${escapeHtml(attempt.run_id ?? 'unknown')} · Status: ${escapeHtml(attemptStatus(attempt))}</p>`,
    summary ? [
      '<section><h2>Short Summary</h2>',
      summary.headline ? `<p><strong>${escapeHtml(summary.headline)}</strong></p>` : '',
      summary.bottleneck ? `<p>Primary finding: ${escapeHtml(summary.bottleneck)}</p>` : '',
      summary.planningRationale ? `<p>Planning rationale: ${escapeHtml(summary.planningRationale)}</p>` : '',
      summary.keyMetrics.length ? `<h3>Key Metrics</h3>${listHtml(summary.keyMetrics)}` : '',
      '</section>',
      `<section><h2>Observed Diagnosis Excerpts</h2>${listHtml(summary.narrative.diagnosis)}</section>`,
      `<section><h2>Observed Planning &amp; Roadmap Excerpts</h2>${listHtml(summary.narrative.planning)}</section>`,
    ].join('') : '',
    comp ? `<section><h2>Reference Checks</h2><ul>${comp.checks.map(check =>
      `<li>${escapeHtml(check.label)}: expected ${escapeHtml(String(check.expected ?? 'unresolved'))}, observed ${escapeHtml(String(check.observed ?? 'unavailable'))}</li>`,
    ).join('')}</ul></section>` : '',
    '</body></html>',
  ].join('');
}

function downloadSummaryHtml(html: string, attempt: SuiteAttempt) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `FinOps_Golden_Standard_${attempt.case_id}_${attempt.repetition}_Summary.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describeSuiteError(code: string): string {
  switch (code) {
    case 'GOLDEN_STANDARD_TOKEN_MISSING':
    case 'GOLDEN_STANDARD_TOKEN_INVALID':
      return 'Vercel Blob token is missing or invalid on Railway (configure GOLDEN_STANDARD_BLOB_READ_WRITE_TOKEN or BLOB_READ_WRITE_TOKEN).';
    case 'GOLDEN_STANDARD_BLOB_FORBIDDEN':
      return 'Railway was denied access to the private Vercel Blob store (HTTP 401/403). Check the Blob read-write token.';
    case 'GOLDEN_STANDARD_BLOB_NOT_FOUND':
      return 'Golden Standard manifest, reference card, or input file was not found in the Vercel Blob store.';
    case 'GOLDEN_STANDARD_INTEGRITY':
      return 'A Golden Standard file or manifest failed SHA-256 or byte-length integrity verification.';
    case 'GOLDEN_STANDARD_CONFIGURATION_MISMATCH':
      return 'The browser build or model-routing configuration differs from the active server deployment. Reload the page and retry.';
    case 'GOLDEN_STANDARD_SUITE_ACTIVE':
    case 'GOLDEN_STANDARD_STATE_CONFLICT':
      return 'Another Golden Standard suite is active or configuration changed. Refresh history or cancel the active test first.';
    case 'GOLDEN_STANDARD_OBSERVATION_MISMATCH':
      return 'Server verification rejected the run observation because it did not match the authoritative assessment checkpoint.';
    default:
      return `Golden Standard request failed (${code}).`;
  }
}

async function fetchReferenceCardForReview(caseId: CaseId): Promise<Comparison> {
  const response = await fetch(`/api/golden-standard-suite?${new URLSearchParams({ caseId, card: '1' })}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('GOLDEN_STANDARD_UNAVAILABLE');
  return response.json();
}

function MonitoringDashboardSummary({ suite }: { suite: Suite }) {
  const summary = summarizeMonitoringDashboard(suite);
  const { gateAccuracy, safetyCritical, evidenceQuality, repeatability: variation, operations } = summary;
  return (
    <section aria-label="Golden Standard monitoring metrics" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      <div className="rounded-lg border border-finops-line bg-finops-surface p-3">
        <p className="finops-kicker">01 · Gate accuracy</p>
        <p className="mt-1 text-base font-bold text-finops-ink">
          {gateAccuracy.evaluable > 0 ? `${gateAccuracy.matched} / ${gateAccuracy.evaluable} matched` : 'No evaluable gate yet'}
        </p>
        <p className="mt-0.5 text-xs text-finops-muted">
          {gateAccuracy.delivered} delivered ({gateAccuracy.delivered - gateAccuracy.evaluable} candidate unresolved)
        </p>
      </div>

      <div className={`rounded-lg border p-3 ${safetyCritical.falseGoCount > 0 ? 'border-rose-300 bg-rose-50' : 'border-finops-line bg-finops-surface'}`}>
        <p className="finops-kicker">02 · Safety-critical</p>
        <p className={`mt-1 text-base font-bold ${safetyCritical.falseGoCount > 0 ? 'text-rose-800' : 'text-finops-ink'}`}>
          {safetyCritical.falseGoCount} / {safetyCritical.expectedBlockCount} false GO
        </p>
        <p className="mt-0.5 text-xs text-finops-muted">Expected BLOCK reported as GO</p>
      </div>

      <div className="rounded-lg border border-finops-line bg-finops-surface p-3">
        <p className="finops-kicker">03 · Evidence quality</p>
        <p className="mt-1 text-base font-bold text-finops-ink">
          {evidenceQuality.unsupportedClaims} / {evidenceQuality.totalClaims} unsupported
        </p>
        <p className="mt-0.5 text-xs text-finops-muted">
          Ev {evidenceQuality.byCategory.evidence} · Inf {evidenceQuality.byCategory.inference} · Scope {evidenceQuality.byCategory.scope} · Sanitized {evidenceQuality.sanitizedClaims}
        </p>
      </div>

      <div className="rounded-lg border border-finops-line bg-finops-surface p-3">
        <p className="finops-kicker">04 · Repeatability</p>
        {variation.length > 0 ? (
          <div className="mt-1 space-y-0.5 text-xs text-finops-muted">
            {variation.slice(0, 2).map(entry => (
              <p key={entry.caseId} className="truncate">
                <strong className="text-finops-ink">{entry.name}:</strong>{' '}
                {entry.adjustedMaturity
                  ? `mat ${entry.adjustedMaturity.values.join('·')} (med ${entry.adjustedMaturity.median}, Δ${entry.adjustedMaturity.range})`
                  : entry.assessed
                    ? `${entry.assessed.values.join('·')}/60 assessed (Δ${entry.assessed.range})`
                    : 'N/A'}
              </p>
            ))}
            {variation.length > 2 && <p>+{variation.length - 2} more case(s) below</p>}
          </div>
        ) : (
          <p className="mt-1 text-xs text-finops-muted">No completed runs yet</p>
        )}
      </div>

      <div className="rounded-lg border border-finops-line bg-finops-surface p-3">
        <p className="finops-kicker">05 · Operations</p>
        <p className="mt-1 text-base font-bold text-finops-ink">
          {operations.completed} / {operations.total} completed
        </p>
        <p className="mt-0.5 text-xs text-finops-muted">
          {operations.timedOut} timed out · {operations.failed} failed{operations.skipped > 0 ? ` · ${operations.skipped} skipped` : ''}
        </p>
      </div>
    </section>
  );
}

function ResultDetail({ attempt, suite, history, report, loadedCard, onLoadCard, onReview, disabled }: {
  attempt: SuiteAttempt;
  suite: Suite;
  history: Suite[];
  report?: SuiteReport;
  loadedCard?: Comparison;
  onLoadCard: () => void;
  onReview: (review: NarrativeReview) => void;
  disabled: boolean;
}) {
  const result = attempt.comparison;
  const repeat = repeatability(history, suite, attempt);
  if (!result) {
    if (attempt.state !== 'incomplete') return null;
    const failureDetail = attempt.failure
      ? ` Stage: ${attempt.failure.stage} · Code: ${attempt.failure.code}${attempt.failure.timedOut ? ' (timed out)' : ''}.`
      : '';
    return (
      <p className="mt-2 text-finops-muted">
        Assessment incomplete.{failureDetail} Cleanup {attempt.cleanup_status === 'verified' ? 'verified' : 'pending or unavailable'}.
      </p>
    );
  }
  const seconds = attempt.started_at && attempt.finished_at
    ? Math.max(0, (Date.parse(attempt.finished_at) - Date.parse(attempt.started_at)) / 1000).toFixed(1) : 'Unknown';
  const storedSummary = attempt.summary;
  const shortSummary = storedSummary ?? (report?.shortSummary ? { ...report.shortSummary, narrative: report.narrative! } : null);
  const monitoring = result.monitoring;
  const narrative = report?.narrative ?? storedSummary?.narrative;
  const reviewComparison: Comparison | undefined = report?.comparison ?? (loadedCard
    ? {
        ...loadedCard,
        referenceVersion: result.referenceVersion,
        referenceSha256: result.referenceSha256,
        referenceApproved: result.referenceApproved,
        checks: result.checks,
      }
    : undefined);
  const existingReview: NarrativeReview | undefined = report?.review ?? (attempt.review && attempt.run_id && reviewComparison?.packageVersion && result.referenceSha256
    ? {
        runId: attempt.run_id,
        referenceIdentity: [reviewComparison.packageVersion, result.referenceVersion, result.referenceSha256].join('/'),
        reviewer: 'Recorded review',
        reviewedAt: attempt.review.reviewedAt,
        judgments: attempt.review.dispositions as Record<string, Disposition>,
        note: '',
      }
    : undefined);

  return (
    <div className="mt-2 space-y-2 px-2 pb-3 text-sm text-finops-muted">
      {shortSummary && (shortSummary.headline || shortSummary.bottleneck || shortSummary.planningRationale) && (
        <div className="rounded-lg border border-finops-line bg-finops-surface p-3 text-finops-ink">
          <p className="finops-kicker">Run short summary</p>
          {shortSummary.headline && <p className="mt-1 font-semibold">{shortSummary.headline}</p>}
          {shortSummary.bottleneck && <p className="mt-1 text-xs text-finops-muted"><strong className="text-finops-ink">Diagnosis:</strong> {shortSummary.bottleneck}</p>}
          {shortSummary.planningRationale && <p className="mt-1 text-xs text-finops-muted"><strong className="text-finops-ink">Planning:</strong> {shortSummary.planningRationale}</p>}
          {shortSummary.keyMetrics.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-finops-muted">
              {shortSummary.keyMetrics.map((metric, index) => <li key={index}>{metric}</li>)}
            </ul>
          )}
        </div>
      )}

      {result.falseGoOnExpectedBlock && (
        <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 font-semibold text-rose-800">
          Safety-critical mismatch: expected BLOCK case produced a GO decision.
        </p>
      )}

      <p>Run {attempt.run_id} · {result.assessed}/60 criteria assessed · {seconds} s · {result.usage.calls} authorized model calls</p>
      {monitoring && (
        <p>
          Band: <strong className="text-finops-ink">{monitoring.crawlWalkRun}</strong>
          {' · '}Adjusted maturity: {monitoring.adjustedMaturity === null ? 'N/A' : `${monitoring.adjustedMaturity}%`}
          {' · '}Observed: {monitoring.observedMaturity === null ? 'N/A' : `${monitoring.observedMaturity}%`}
          {' · '}Corroborated: {monitoring.corroboratedMaturity === null ? 'N/A' : `${monitoring.corroboratedMaturity}%`}
          {' · '}Resolution: {monitoring.assessmentResolution}%
          {' · '}Evidence density: {monitoring.criterionEvidenceDensity}%
          {' · '}Burden: {monitoring.antipatternBurden}%
          {' · '}Admitted inputs: {monitoring.admittedCustomerSources}/{monitoring.expectedCustomerSources}
          {' · '}Unsupported claims: {monitoring.factCheck.unsupportedClaims}/{monitoring.factCheck.totalClaims}
        </p>
      )}
      <p>{result.usage.input_tokens ?? 'Unknown'} input / {result.usage.output_tokens ?? 'unknown'} output tokens</p>
      <p className="break-all">
        Reference {result.referenceVersion} · {result.referenceApproved ? 'Approved' : 'Review candidate'}
        {result.serverVerified ? ' · Server-verified checkpoint' : ''} · SHA-256 {result.referenceSha256}
      </p>
      <p className="break-all">Knowledge Base fingerprint {result.kbHash ?? 'unknown'}</p>
      {repeat && <p>Matching results on this configuration {repeat.matched}/{repeat.total} in recent history</p>}
      {!!result.usage.models.length && <details><summary className="cursor-pointer">Models used</summary>
        <ul className="ml-3">{result.usage.models.map(model => <li key={model}>{model}</li>)}</ul>
      </details>}
      {monitoring && monitoring.assessedCriteria.length > 0 && (
        <details>
          <summary className="cursor-pointer">Assessed criteria ({monitoring.assessedCriteria.length})</summary>
          <p className="mt-1 break-words text-xs">{monitoring.assessedCriteria.join(', ')}</p>
        </details>
      )}
      <ul className="space-y-1">
        {result.checks.map(check => <li key={check.label} className={check.matches === false ? 'text-rose-800' : 'text-finops-muted'}>
          {check.label} · Expected {check.expected === null ? 'unresolved' : String(check.expected)} · Observed {check.observed === null ? 'unavailable' : String(check.observed)}
        </li>)}
      </ul>
      {attempt.review && <p>Review recorded {new Date(attempt.review.reviewedAt).toLocaleString()} · {Object.values(attempt.review.dispositions).join(', ')}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {(report?.summary || storedSummary) && (
          <button
            type="button"
            className="finops-button"
            onClick={() => downloadSummaryHtml(report?.summary ?? buildFallbackSummaryHtml(attempt), attempt)}
          >
            Download Summary
          </button>
        )}
        {narrative && !reviewComparison && attempt.run_id && (
          <button type="button" className="finops-button" disabled={disabled} onClick={onLoadCard}>
            Load reference card for review
          </button>
        )}
      </div>
      {narrative && reviewComparison && attempt.run_id ? (
        <ClearBlockReview
          result={{
            comparison: reviewComparison,
            narrative,
            review: existingReview,
            summary: report?.summary ?? '',
            runId: attempt.run_id,
            completedAt: report?.completedAt ?? attempt.finished_at ?? new Date().toISOString(),
            cleanupVerified: true,
          }}
          disabled={disabled}
          onSave={onReview}
        />
      ) : !narrative && (
        <p className="text-finops-muted">Summary and Master Data excerpts were not captured for this earlier run.</p>
      )}
    </div>
  );
}

const globalFailureCodes = new Set([
  'GOLDEN_STANDARD_TOKEN_MISSING',
  'GOLDEN_STANDARD_TOKEN_INVALID',
  'GOLDEN_STANDARD_BLOB_FORBIDDEN',
]);

export function GoldenStandardSuite({ deepMode }: { deepMode: boolean }) {
  const [history, setHistory] = useState<Suite[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selection, setSelection] = useState<Selection>('clear-block');
  const [repetitions, setRepetitions] = useState<1 | 3>(1);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState('');
  const [reports, setReports] = useState(loadReports);
  const [loadedCards, setLoadedCards] = useState<Partial<Record<CaseId, Comparison>>>({});
  const operation = useRef<{ id: string; controller: AbortController; started: Promise<Suite> } | null>(null);
  const cancellingRef = useRef(false);
  const active = history.find(suite => suite.state === 'running');
  const selected = history.find(suite => suite.suite_id === selectedId) ?? history[0];

  useEffect(() => {
    let ignore = false;
    (async () => {
      const { flushPendingGoldenStandardDeliveries } = await import('../monitoring/verifyGoldenStandardAttempt');
      await flushPendingGoldenStandardDeliveries().catch(() => {});
      return loadSuiteHistory();
    })().then(suites => {
      if (!ignore) { setHistory(suites); setLoaded(true); }
    }).catch(() => {
      if (!ignore) setMessage('Golden Standard history is unavailable.');
    }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, []);

  function update(suite: Suite) {
    setHistory(previous => [suite, ...previous.filter(entry => entry.suite_id !== suite.suite_id)]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 30));
  }

  async function refresh() {
    setLoading(true);
    try {
      const { flushPendingGoldenStandardDeliveries } = await import('../monitoring/verifyGoldenStandardAttempt');
      await flushPendingGoldenStandardDeliveries().catch(() => {});
      setHistory(await loadSuiteHistory());
      setLoaded(true);
      setMessage('');
    }
    catch { setMessage('Golden Standard history is unavailable.'); }
    finally { setLoading(false); }
  }

  async function loadCard(caseId: CaseId) {
    if (loadedCards[caseId]) return;
    try {
      const card = await fetchReferenceCardForReview(caseId);
      setLoadedCards(current => ({ ...current, [caseId]: card }));
    } catch {
      setMessage('Could not load the reference card for review.');
    }
  }

  async function start() {
    if (operation.current || active || cancellingRef.current) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const started = (async () => {
      const routingHash = await digest(await getModelRoutingConfig(true));
      controller.signal.throwIfAborted();
      return suiteCommand<Suite>('start', id, {
        selection, repetitions, deepMode, build: __FINOPS_BUILD_COMMIT__, routingHash,
      });
    })();
    operation.current = { id, controller, started };
    setBusy(true);
    setMessage('');
    try {
      let suite = await started;
      update(suite);
      setSelectedId(id);
      let mergedReports = loadReports();
      let latestFailureNotice = '';
      const { GoldenStandardAttemptError, verifyGoldenStandardAttempt } = await import('../monitoring/verifyGoldenStandardAttempt');
      while (suite.state === 'running' && !controller.signal.aborted) {
        if (await digest(await getModelRoutingConfig(true)) !== suite.configuration.routingHash) {
          throw new GoldenStandardClientError('GOLDEN_STANDARD_STATE_CONFLICT', 'GOLDEN_STANDARD_CONFIGURATION_MISMATCH');
        }
        controller.signal.throwIfAborted();
        const attempt = await suiteCommand<SuiteAttempt>('next', id);
        controller.signal.throwIfAborted();
        try {
          const { updated, report } = await verifyGoldenStandardAttempt(suite, attempt, controller.signal);
          suite = updated;
          if (attempt.run_id) {
            mergedReports = { ...mergedReports, [attempt.run_id]: report };
            saveReports(mergedReports);
            setReports(mergedReports);
          }
          update(suite);
        } catch (attemptError) {
          if (controller.signal.aborted) throw attemptError;
          const failure = attemptError instanceof GoldenStandardAttemptError
            ? { stage: attemptError.stage, code: attemptError.code, timedOut: attemptError.timedOut }
            : { stage: 'pipeline' as const, code: 'PIPELINE_FAILED', timedOut: false };
          latestFailureNotice = `${caseNames[attempt.case_id]} incomplete at ${failure.stage} (${failure.code}). ${describeSuiteError(failure.code)}`;
          if (attempt.run_id) {
            suite = await suiteCommand<Suite>('fail', id, {
              ordinal: attempt.ordinal,
              runId: attempt.run_id,
              failure,
            });
            update(suite);
          }
          if (globalFailureCodes.has(failure.code)) {
            if (suite.state === 'running') {
              const closed = await suiteCommand<Suite>('cancel', id);
              update(closed);
            }
            break;
          }
        }
      }
      if (latestFailureNotice) setMessage(latestFailureNotice);
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          const histories = await loadSuiteHistory();
          if (histories.some(suite => suite.suite_id === id && suite.state === 'running')) {
            const closed = await suiteCommand<Suite>('cancel', id);
            setHistory([closed, ...histories.filter(suite => suite.suite_id !== id)]);
          } else setHistory(histories);
        } catch {
          setMessage('The run was interrupted. Refresh history to identify and close any active test.');
          return;
        }
        const reason = error instanceof GoldenStandardClientError
          ? error.reason
          : error instanceof Error ? error.message : 'GOLDEN_STANDARD_UNAVAILABLE';
        setMessage(describeSuiteError(reason));
      }
    } finally {
      operation.current = null;
      setBusy(false);
    }
  }

  async function cancel() {
    const work = operation.current;
    const id = work?.id ?? active?.suite_id;
    if (!id || cancellingRef.current) return;
    cancellingRef.current = true;
    work?.controller.abort();
    setCancelling(true);
    setMessage('');
    try {
      await work?.started.catch(() => null);
      const closed = await suiteCommand<Suite | null>('cancel', id);
      if (closed) update(closed);
      setMessage('Cancellation requested. Completed results are retained.');
    } catch { setMessage('Cancellation could not be verified. Refresh history and check the active test.'); }
    finally { cancellingRef.current = false; setCancelling(false); }
  }

  async function saveReview(suite: Suite, attempt: SuiteAttempt, review: NarrativeReview) {
    const referenceSha256 = attempt.comparison?.referenceSha256;
    if (!attempt.run_id || !referenceSha256) return;
    setReviewing(true);
    setMessage('');
    try {
      const updated = await suiteCommand<Suite>('review', suite.suite_id, {
        ordinal: attempt.ordinal, runId: attempt.run_id, referenceSha256, dispositions: review.judgments,
      });
      const existingReport = reports[attempt.run_id];
      if (existingReport) {
        const next = { ...reports, [attempt.run_id]: { ...existingReport, review } };
        saveReports(next);
        setReports(next);
      }
      update(updated);
    } catch { setMessage('The review could not be saved.'); }
    finally { setReviewing(false); }
  }

  const planned = (selection === 'all' ? 5 : 1) * repetitions;
  const finished = selected?.attempts.filter(attempt => attempt.state === 'delivered').length ?? 0;
  const failed = selected?.attempts.filter(attempt => attemptStatus(attempt) === 'Fail').length ?? 0;

  return (
    <div className="min-w-0 rounded-xl border border-finops-line bg-finops-soft p-4 text-sm">
      <h3 className="text-sm font-bold">Last full Golden Standard test</h3>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 max-w-full gap-1">Cases
          <select className="finops-field" value={selection} disabled={busy || !!active}
            onChange={event => setSelection(event.currentTarget.value as Selection)}>
            {caseIds.map(id => <option key={id} value={id}>{caseNames[id]}</option>)}
            <option value="all">All five cases</option>
          </select>
        </label>
        <label className="grid min-w-0 max-w-full gap-1">Repetitions
          <select className="finops-field" value={repetitions} disabled={busy || !!active}
            onChange={event => setRepetitions(Number(event.currentTarget.value) === 3 ? 3 : 1)}>
            <option value={1}>1 assessment per case</option>
            <option value={3}>3 assessments per case</option>
          </select>
        </label>
        <button type="button" className="finops-primary" disabled={loading || !loaded || busy || !!active || cancelling || reviewing}
          onClick={() => void start()}>Start {planned} {planned === 1 ? 'assessment' : 'assessments'}</button>
        {(busy || active) && <button type="button" className="finops-button" disabled={cancelling}
          onClick={() => void cancel()}>Cancel active test</button>}
        <button type="button" className="finops-button" disabled={loading || busy || cancelling || reviewing}
          onClick={() => void refresh()}>Refresh history</button>
      </div>
      <div className="mt-2 space-y-1 text-finops-muted" role="status">
        {message && <p className="font-medium text-finops-ink">{message}</p>}
        <p>{loading ? 'Loading history…' : selected
          ? `${suiteStatus(selected)} · ${finished} of ${selected.attempts.length} complete · ${failed} failed`
          : 'No full-case result available.'}</p>
      </div>
      {selected && <>
        <MonitoringDashboardSummary suite={selected} />
        <label className="mt-3 grid max-w-md gap-1">Run history
          <select className="finops-field" value={selected.suite_id} onChange={event => setSelectedId(event.currentTarget.value)}>
            {history.map(suite => {
              const first = suite.attempts[0];
              const single = first && new Set(suite.attempts.map(attempt => attempt.case_id)).size === 1;
              return <option key={suite.suite_id} value={suite.suite_id}>
                {new Date(suite.created_at).toLocaleString()} · {single ? caseNames[first.case_id] : 'Five-case suite'} · {suiteStatus(suite)}
              </option>;
            })}
          </select>
        </label>
        <details className="mt-2 text-finops-muted">
          <summary className="cursor-pointer">Run configuration</summary>
          <p className="break-all">{selected.suite_id} · Build {selected.configuration.build ?? 'unidentified'}</p>
          <p className="break-all">{selected.configuration.packageVersion} · {selected.configuration.deepMode ? 'Deep' : 'Standard'} · {selected.configuration.routingLabel} · {selected.configuration.routingHash}</p>
          <ul>{Object.entries(selected.configuration.models).map(([role, models]) => <li key={role}>{role} · {models.join(' → ')}</li>)}</ul>
        </details>
        <div className="mt-3 divide-y divide-finops-line border-y border-finops-line">
          {caseIds.map(id => {
            const attempts = selected.attempts.filter(attempt => attempt.case_id === id);
            return <div key={id} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
              <h4 className="min-w-48 font-medium">{caseNames[id]}</h4>
              {attempts.length === 0 && <span className="text-finops-muted">Unselected</span>}
              {attempts.map(attempt => <details key={attempt.ordinal} className="min-w-0 flex-1 basis-80">
                <summary className="cursor-pointer text-finops-muted">
                  {attempts.length > 1 && `Run ${attempt.repetition} · `}
                  {selected.state === 'cancelled' && attempt.state === 'queued' ? 'Skipped' : attemptStatus(attempt)}
                  {attempt.comparison?.observedDecisions && ` · ${attempt.comparison.observedDecisions.qualityGate} / ${attempt.comparison.observedDecisions.planningDecision}`}
                  {attempt.failure && ` · ${attempt.failure.stage} (${attempt.failure.code})`}
                </summary>
                <ResultDetail
                  attempt={attempt}
                  suite={selected}
                  history={history}
                  disabled={busy || reviewing}
                  report={attempt.run_id ? reports[attempt.run_id] : undefined}
                  loadedCard={loadedCards[attempt.case_id]}
                  onLoadCard={() => void loadCard(attempt.case_id)}
                  onReview={review => void saveReview(selected, attempt, review)}
                />
              </details>)}
            </div>;
          })}
        </div>
      </>}
    </div>
  );
}
