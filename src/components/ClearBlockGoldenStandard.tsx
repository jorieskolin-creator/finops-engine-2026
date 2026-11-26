import { useState, type FormEvent } from 'react';
import {
  dispositions, matchingReview, monitoringStatus, narrativeStatus, referenceIdentity,
  type Disposition, type NarrativeReview,
} from '../monitoring/clearBlockNarrativeReview';
import type { ClearBlockResult, ClearBlockSession } from '../monitoring/clearBlockVerification';
import { deleteRun } from '../services/runLifecycleService';

let operationActive = false;
const key = 'finops:golden-standard:clear-block:v1';
const button = 'rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50';
const field = 'w-full rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100';

function readSession(): ClearBlockSession | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
}

function ReportExcerpts({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <h5 className="font-semibold text-slate-100">{title}</h5>
      {lines.length ? <ul className="mt-1 list-disc space-y-1 pl-4">
        {lines.map((line, index) => <li key={index}>{line}</li>)}
      </ul> : <p className="mt-1 text-slate-400">No text appeared in this section.</p>}
    </div>
  );
}

export function ClearBlockReview({ result, disabled, onSave }: {
  result: ClearBlockResult;
  disabled: boolean;
  onSave: (review: NarrativeReview) => void;
}) {
  const { comparison, narrative, runId } = result;
  const saved = matchingReview(runId, comparison, result.review);
  const [judgments, setJudgments] = useState<Record<string, Disposition>>(saved?.judgments ?? {});
  const [reviewer, setReviewer] = useState(saved?.reviewer ?? '');
  const [note, setNote] = useState(saved?.note ?? '');
  const identity = referenceIdentity(comparison);
  const checks = comparison?.narrativeChecks;
  if (!checks?.length || !narrative || !identity) return <p className="mt-3 text-slate-400">Run the case to capture the diagnosis and roadmap for review.</p>;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!checks?.length || !identity || !reviewer.trim()) return;
    onSave({
      runId, referenceIdentity: identity, reviewer: reviewer.trim(), reviewedAt: new Date().toISOString(),
      judgments: Object.fromEntries(checks.map(check => [check.id, judgments[check.id] ?? 'Needs judgment'])),
      note: note.trim(),
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 border-t border-slate-700 pt-3">
      <h4 className="font-semibold text-slate-100">Diagnosis and roadmap review · {narrativeStatus(comparison, saved)}</h4>
      <p>Accept equivalent wording. Mark required content as Missing if it is absent. For an optional claim that was omitted, choose Supported if the report respects the stated limit. Read the full Summary for consequential claims and actions beyond these excerpts.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-3 rounded-lg border border-slate-700 p-3">
          <h5 className="font-semibold text-slate-100">Reference expectations</h5>
          {checks.map(check => (
            <fieldset key={check.id} className="space-y-1 border-b border-slate-700 pb-2">
              <legend className="font-medium text-slate-100">{check.label}</legend>
              {check.expected.map((line, index) => <p key={index}>{line}</p>)}
              {check.sources?.map(source => (
                <p key={source.file} className="break-words text-xs text-slate-400">{source.file} · {source.locator}</p>
              ))}
              <select aria-label={`Disposition for ${check.label}`} className={field} disabled={disabled}
                value={judgments[check.id] ?? 'Needs judgment'}
                onChange={event => setJudgments({ ...judgments, [check.id]: event.currentTarget.value as Disposition })}>
                {dispositions.map(disposition => <option key={disposition}>{disposition}</option>)}
              </select>
            </fieldset>
          ))}
        </div>
        <div className="min-w-0 space-y-3 break-words rounded-lg border border-slate-700 p-3">
          <ReportExcerpts title="Observed Summary diagnosis and findings" lines={narrative.diagnosis} />
          <ReportExcerpts title="Observed Summary planning and roadmap" lines={narrative.planning} />
          <details>
            <summary className="cursor-pointer">Compare Master Data findings</summary>
            <div className="mt-2"><ReportExcerpts title="Observed Master Data findings" lines={narrative.masterData} /></div>
          </details>
        </div>
      </div>
      <label className="block max-w-md">Reviewer name or ID
        <input className={field} value={reviewer} onChange={event => setReviewer(event.currentTarget.value)} disabled={disabled} maxLength={100} required />
      </label>
      <label className="block">Review note (optional)
        <textarea className={field} value={note} onChange={event => setNote(event.currentTarget.value)} disabled={disabled} maxLength={2000} rows={2} />
      </label>
      <button type="submit" className={button} disabled={disabled || !reviewer.trim()}>Save review</button>
      {saved && <p className="text-xs text-slate-400">Saved for {saved.reviewer} · {new Date(saved.reviewedAt).toLocaleString()}</p>}
    </form>
  );
}

export function ClearBlockGoldenStandard({ deepMode, legacy = false }: { deepMode: boolean; legacy?: boolean }) {
  const [session, setSession] = useState(readSession);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const result = session?.result;
  const differences = result?.comparison?.checks.filter(check => !check.matches).length ?? 0;
  const review = result ? matchingReview(result.runId, result.comparison, result.review) : undefined;
  const status = monitoringStatus(result?.comparison, review);
  const requiresCleanup = Boolean(session && !result?.cleanupVerified);

  function save(next: ClearBlockSession) {
    sessionStorage.setItem(key, JSON.stringify(next));
    setSession(next);
  }

  function saveReview(next: NarrativeReview) {
    if (operationActive || !result) return;
    try {
      save({ runId: result.runId, result: { ...result, review: next } });
      setNotice(null);
    } catch {
      setNotice('The reviewer disposition could not be saved in this browser session.');
    }
  }

  async function start() {
    if (operationActive) return;
    const previous = readSession();
    if (previous && !previous.result?.cleanupVerified) return;
    operationActive = true;
    setBusy(true);
    setNotice(null);
    let recordedRunId: string | undefined;
    try {
      // Persist intent before any analysis. Neither reloads nor failed responses
      // can launch a replacement assessment automatically.
      save({});
      const { verifyClearBlock } = await import('../monitoring/clearBlockVerification');
      const delivered = await verifyClearBlock(deepMode, runId => {
        recordedRunId = runId;
        save({ runId });
      }, report => save({ runId: report.runId, result: report }));
      save({ runId: delivered.runId, result: delivered });
    } catch (error) {
      if (!recordedRunId) {
        try {
          if (previous) save(previous);
          else { sessionStorage.removeItem(key); setSession(null); }
        } catch {
          setSession(previous);
        }
      }
      const code = error instanceof Error ? error.message : '';
      setNotice(code === 'GOLDEN_STANDARD_INTEGRITY' ? 'The frozen input or reference failed verification.'
        : code === 'GOLDEN_STANDARD_UNAVAILABLE' ? 'The private Clear BLOCK case pack is unavailable.'
          : 'The check was interrupted or its result could not be saved.');
    } finally {
      operationActive = false;
      setBusy(false);
    }
  }

  async function closePrevious() {
    if (operationActive) return;
    operationActive = true;
    setBusy(true);
    setNotice(null);
    try {
      if (session?.runId) {
        const closed = await deleteRun(session.runId);
        if (closed.cleanup_status !== 'verified') throw new Error('GOLDEN_STANDARD_CLEANUP_PENDING');
      }
      if (session?.result) save({ ...session, result: { ...session.result, cleanupVerified: true } });
      else { sessionStorage.removeItem(key); setSession(null); }
    } catch {
      setNotice('Cleanup is still pending. Check again before starting another run.');
    } finally {
      operationActive = false;
      setBusy(false);
    }
  }

  function downloadSummary() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.summary], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'FinOps_Golden_Standard_Clear_BLOCK_Summary.html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (legacy && !session) return null;
  return (
    <div className={`min-w-0 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 ${legacy ? 'lg:col-span-2' : ''}`}>
      <h2 className="text-sm font-semibold text-slate-100">{legacy ? 'Previous Clear BLOCK session' : 'Last full Golden Standard test'}</h2>
      <p className="mt-2 text-sm text-slate-300" role="status">
        {busy ? 'Working on Clear BLOCK…' : notice
          ?? (result?.comparison ? `Clear BLOCK · ${status}${differences ? ` · ${differences} deterministic differences` : ''}` : result ? 'Clear BLOCK · Incomplete · comparison unavailable'
            : session ? 'The previous check was interrupted.' : 'No full-case result available.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {requiresCleanup && !busy
          ? <button type="button" className={button} onClick={() => void closePrevious()}>Close previous check</button>
          : !legacy && <button type="button" className={button} disabled={busy} onClick={() => void start()}>Run Clear BLOCK</button>}
        {result && <button type="button" className={button} onClick={downloadSummary}>Download Summary</button>}
      </div>
      {result && (
        <details className="mt-3 text-sm text-slate-300">
          <summary className="cursor-pointer">Reference comparison</summary>
          <p className="my-2 text-xs text-slate-400">{new Date(result.completedAt).toLocaleString()} · {result.runId}</p>
          {result.comparison && (
            <>
              <p className="my-2">
                Reference {result.comparison.referenceVersion} · {result.comparison.referenceApproved ? 'Approved' : 'Review candidate'}
              </p>
              {result.comparison.referenceSha256 &&
                <p className="my-2 break-all text-xs text-slate-400">{result.comparison.packageVersion} · SHA-256 {result.comparison.referenceSha256}</p>}
              <ul className="space-y-1">
                {result.comparison.checks.map(check => (
                  <li key={check.label} className={check.matches ? 'text-emerald-200' : 'text-amber-200'}>
                    {check.label} · Expected {String(check.expected)} · Observed {String(check.observed)} · {check.matches ? 'Match' : 'Mismatch'}
                  </li>
                ))}
              </ul>
              <ClearBlockReview key={result.runId} result={result} disabled={busy} onSave={saveReview} />
            </>
          )}
        </details>
      )}
    </div>
  );
}
