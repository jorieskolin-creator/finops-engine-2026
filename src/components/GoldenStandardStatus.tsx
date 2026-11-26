import { GoldenStandardSuite } from './GoldenStandardSuite';
import { ClearBlockGoldenStandard } from './ClearBlockGoldenStandard';
import type { OpeningRetrievalCheck } from '../monitoring/useOpeningRetrievalCheck';
import type { RetrievalVerificationResult } from '../monitoring/retrievalVerification';

const checkLabels: Record<keyof NonNullable<RetrievalVerificationResult['checks']>, string> = {
  fixtureHashes: 'Fixture files differ from the reference',
  directEvidence: 'Expected billing evidence is missing',
  calculation: 'Billing calculation differs from the reference',
  gapPresentOnFirstPass: 'The forecast was already present before the gap check',
  recoveredEvidence: 'Expected forecast evidence was not recovered',
  irrelevantEvidenceExcluded: 'Unrelated evidence entered a packet',
};

const statusColors = {
  Running: 'bg-cyan-400/10 text-cyan-200',
  Pass: 'bg-emerald-400/10 text-emerald-200',
  Fail: 'bg-rose-400/10 text-rose-200',
  Review: 'bg-amber-400/10 text-amber-200',
  Incomplete: 'bg-amber-400/10 text-amber-200',
};

export function GoldenStandardStatus({ check, deepMode }: { check: OpeningRetrievalCheck | null; deepMode: boolean }) {
  const result = check?.result;
  const status = result?.status ?? 'Running';
  const reason = result?.reason;
  const checks = result?.checks;
  let message: string = reason ?? 'Checking the synthetic evidence and AI Gap Analyzer.';
  if (reason === 'Fixture needs review' && checks) {
    message = !checks.fixtureHashes ? checkLabels.fixtureHashes : checkLabels.gapPresentOnFirstPass;
  } else if (reason === 'Deterministic check failed' && checks) {
    const first = (['directEvidence', 'calculation', 'irrelevantEvidenceExcluded'] as const).find(key => !checks[key]);
    message = first ? checkLabels[first] : 'Packet integrity or privacy checks failed';
  } else if (reason === 'AI recovery failed') {
    message = 'The AI Gap Analyzer returned a valid query, but it did not recover the expected forecast evidence.';
  } else if (reason === 'Retrieval deadline exceeded') {
    message = 'The retrieval deadline expired before the AI check could be verified.';
  } else if (reason === 'AI Gap Analyzer unverified') {
    message = checks?.recoveredEvidence
      ? 'Local recovery passed. The AI Gap Analyzer produced no verified response.'
      : 'The AI Gap Analyzer produced no verified response.';
  } else if (reason === 'Verified') {
    message = 'Evidence, calculation and packet checks passed.';
  }
  const build = __FINOPS_BUILD_COMMIT__;

  return (
    <section aria-label="Golden Standard monitoring" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2" role="status">
          <h2 className="text-sm font-semibold text-slate-100">Retrieval check on this opening</h2>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusColors[status]}`}>{status}</span>
          <p className="basis-full text-sm text-slate-300">{message}</p>
        </div>
        {check && (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
            <time dateTime={check.completedAt}>{new Date(check.completedAt).toLocaleString()}</time>
            <span title={build || undefined}>Build {build ? build.slice(0, 12) : 'unidentified'}</span>
            {result && result.durationMs > 0 && <span>{(result.durationMs / 1000).toFixed(1)} s</span>}
            {result?.model && <span>{result.model}</span>}
            {result?.runId && <span className="break-all">Run {result.runId}</span>}
            {result?.usage && (
              <span>
                {result.usage.input_tokens ?? 'unknown'} input / {result.usage.output_tokens ?? 'unknown'} output tokens
              </span>
            )}
            {result?.usage && <span>{result.usage.authorized_attempts} of {result.usage.reserved_attempts} model attempts authorized</span>}
          </p>
        )}
      </div>
      <GoldenStandardSuite deepMode={deepMode} />
      <ClearBlockGoldenStandard deepMode={deepMode} legacy />
    </section>
  );
}
