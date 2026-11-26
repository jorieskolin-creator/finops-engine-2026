import { useState } from 'react';
import type { ClearBlockSession } from '../monitoring/clearBlockVerification';
import { deleteRun } from '../services/runLifecycleService';

let operationActive = false;
const key = 'finops:golden-standard:clear-block:v1';
const button = 'rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50';

function readSession(): ClearBlockSession | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
}

export function ClearBlockGoldenStandard({ deepMode }: { deepMode: boolean }) {
  const [session, setSession] = useState(readSession);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const result = session?.result;
  const differences = result?.comparison?.checks.filter(check => !check.matches).length ?? 0;
  const requiresCleanup = Boolean(session && !result?.cleanupVerified);

  function save(next: ClearBlockSession) {
    setSession(next);
    sessionStorage.setItem(key, JSON.stringify(next));
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

  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3">
      <h2 className="text-sm font-semibold text-slate-100">Last full Golden Standard test</h2>
      <p className="mt-2 text-sm text-slate-300" role="status">
        {busy ? 'Working on Clear BLOCK…' : notice
          ?? (result?.comparison ? `Clear BLOCK · Review required${differences ? ` · ${differences} differences` : ''}` : result ? 'Summary ready · comparison unavailable'
            : session ? 'The previous check was interrupted.' : 'No full-case result available.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {requiresCleanup && !busy
          ? <button type="button" className={button} onClick={() => void closePrevious()}>Close previous check</button>
          : <button type="button" className={button} disabled={busy} onClick={() => void start()}>Run Clear BLOCK</button>}
        {result && <button type="button" className={button} onClick={downloadSummary}>Download Summary</button>}
      </div>
      {result && (
        <details className="mt-3 text-sm text-slate-300">
          <summary className="cursor-pointer">Reference comparison</summary>
          <p className="my-2 text-xs text-slate-400">{new Date(result.completedAt).toLocaleString()} · {result.runId}</p>
          {result.comparison && (
            <>
              <p className="my-2">Reference {result.comparison.referenceVersion} · Candidate reference and Summary wording await review.</p>
              <ul className="space-y-1">
                {result.comparison.checks.map(check => (
                  <li key={check.label} className={check.matches ? 'text-emerald-200' : 'text-amber-200'}>
                    {check.label} · {check.matches ? 'Match' : `Expected ${check.expected}, observed ${check.observed}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
    </div>
  );
}
