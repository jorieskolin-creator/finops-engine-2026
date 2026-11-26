import { useEffect, useRef, useState } from 'react';
import { getModelRoutingConfig } from '../services/modelRouter';
import type { NarrativeReview } from '../monitoring/clearBlockNarrativeReview';
import {
  attemptStatus, caseIds, caseNames, digest, loadSuiteHistory, repeatability, suiteCommand, suiteStatus,
  type Selection, type Suite, type SuiteAttempt, type SuiteReport,
} from '../monitoring/goldenStandardSuite';
import { ClearBlockReview } from './ClearBlockGoldenStandard';

const reportStorage = 'finops:golden-standard:latest-reports:v1';

function loadReports(): Record<string, SuiteReport> {
  try { return JSON.parse(sessionStorage.getItem(reportStorage) ?? '{}'); }
  catch { return {}; }
}

function saveReports(reports: Record<string, SuiteReport>) {
  try { sessionStorage.setItem(reportStorage, JSON.stringify(reports)); }
  catch { /* The current panel can still display reports in memory. */ }
}

function download(report: SuiteReport, attempt: SuiteAttempt) {
  const url = URL.createObjectURL(new Blob([report.summary], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `FinOps_Golden_Standard_${attempt.case_id}_${attempt.repetition}_Summary.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ResultDetail({ attempt, suite, history, report, onReview, disabled }: {
  attempt: SuiteAttempt;
  suite: Suite;
  history: Suite[];
  report?: SuiteReport;
  onReview: (review: NarrativeReview) => void;
  disabled: boolean;
}) {
  const result = attempt.comparison;
  const repeat = repeatability(history, suite, attempt);
  if (!result) return attempt.state === 'incomplete'
    ? <p className="mt-2 text-finops-muted">Assessment incomplete. Cleanup {attempt.cleanup_status === 'verified' ? 'verified' : 'pending or unavailable'}.</p>
    : null;
  const seconds = attempt.started_at && attempt.finished_at
    ? Math.max(0, (Date.parse(attempt.finished_at) - Date.parse(attempt.started_at)) / 1000).toFixed(1) : 'Unknown';
  return (
    <div className="mt-2 space-y-2 px-2 pb-3 text-sm text-finops-muted">
      <p>Run {attempt.run_id} · {result.assessed}/60 criteria assessed · {seconds} s · {result.usage.calls} authorized model calls</p>
      <p>{result.usage.input_tokens ?? 'Unknown'} input / {result.usage.output_tokens ?? 'unknown'} output tokens</p>
      <p className="break-all">Reference {result.referenceVersion} · {result.referenceApproved ? 'Approved' : 'Review candidate'} · SHA-256 {result.referenceSha256}</p>
      <p className="break-all">Knowledge Base fingerprint {result.kbHash ?? 'unknown'}</p>
      {repeat && <p>Matching results on this configuration {repeat.matched}/{repeat.total} in recent history</p>}
      {!!result.usage.models.length && <details><summary className="cursor-pointer">Models used</summary>
        <ul className="ml-3">{result.usage.models.map(model => <li key={model}>{model}</li>)}</ul>
      </details>}
      <ul className="space-y-1">
        {result.checks.map(check => <li key={check.label} className={check.matches === false ? 'text-rose-800' : 'text-finops-muted'}>
          {check.label} · Expected {check.expected === null ? 'unresolved' : String(check.expected)} · Observed {check.observed === null ? 'unavailable' : String(check.observed)}
        </li>)}
      </ul>
      {attempt.review && <p>Review recorded {new Date(attempt.review.reviewedAt).toLocaleString()} · {Object.values(attempt.review.dispositions).join(', ')}</p>}
      {report && attempt.run_id
        ? <>
          <button type="button" className="finops-button" onClick={() => download(report, attempt)}>Download Summary</button>
          <ClearBlockReview result={{ ...report, runId: attempt.run_id, cleanupVerified: true }} disabled={disabled} onSave={onReview} />
        </>
        : <p className="text-finops-muted">Summary and Master Data excerpts are available in the browser session that ran this package.</p>}
    </div>
  );
}

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
  const operation = useRef<{ id: string; controller: AbortController; started: Promise<Suite> } | null>(null);
  const cancellingRef = useRef(false);
  const active = history.find(suite => suite.state === 'running');
  const selected = history.find(suite => suite.suite_id === selectedId) ?? history[0];

  useEffect(() => {
    let ignore = false;
    loadSuiteHistory().then(suites => {
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
    try { setHistory(await loadSuiteHistory()); setLoaded(true); setMessage(''); }
    catch { setMessage('Golden Standard history is unavailable.'); }
    finally { setLoading(false); }
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
      const fresh: Record<string, SuiteReport> = {};
      const { verifyGoldenStandardAttempt } = await import('../monitoring/verifyGoldenStandardAttempt');
      while (suite.state === 'running' && !controller.signal.aborted) {
        if (await digest(await getModelRoutingConfig(true)) !== suite.configuration.routingHash) {
          throw new Error('GOLDEN_STANDARD_STATE_CONFLICT');
        }
        controller.signal.throwIfAborted();
        const attempt = await suiteCommand<SuiteAttempt>('next', id);
        controller.signal.throwIfAborted();
        const { updated, report } = await verifyGoldenStandardAttempt(suite, attempt, controller.signal);
        suite = updated;
        if (attempt.run_id) fresh[attempt.run_id] = report;
        const snapshot = { ...fresh };
        saveReports(snapshot);
        setReports(snapshot);
        update(suite);
      }
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
        setMessage(error instanceof Error && error.message === 'GOLDEN_STANDARD_STATE_CONFLICT'
          ? 'The suite could not advance. Check for an active run or a changed build or model configuration.'
          : 'The suite was interrupted. Completed results are retained.');
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
    const report = attempt.run_id ? reports[attempt.run_id] : undefined;
    const referenceSha256 = attempt.comparison?.referenceSha256;
    if (!report || !attempt.run_id || !referenceSha256) return;
    setReviewing(true);
    setMessage('');
    try {
      const updated = await suiteCommand<Suite>('review', suite.suite_id, {
        ordinal: attempt.ordinal, runId: attempt.run_id, referenceSha256, dispositions: review.judgments,
      });
      const next = { ...reports, [attempt.run_id]: { ...report, review } };
      saveReports(next);
      setReports(next);
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
        {message && <p>{message}</p>}
        <p>{loading ? 'Loading history…' : selected
          ? `${suiteStatus(selected)} · ${finished} of ${selected.attempts.length} complete · ${failed} failed`
          : 'No full-case result available.'}</p>
      </div>
      {selected && <>
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
              {attempts.map(attempt => <details key={attempt.ordinal} className="min-w-0">
                <summary className="cursor-pointer text-finops-muted">
                  {attempts.length > 1 && `Run ${attempt.repetition} · `}{selected.state === 'cancelled' && attempt.state === 'queued' ? 'Skipped' : attemptStatus(attempt)}
                </summary>
                <ResultDetail attempt={attempt} suite={selected} history={history} disabled={busy || reviewing}
                  report={attempt.run_id ? reports[attempt.run_id] : undefined}
                  onReview={review => void saveReview(selected, attempt, review)} />
              </details>)}
            </div>;
          })}
        </div>
      </>}
    </div>
  );
}
