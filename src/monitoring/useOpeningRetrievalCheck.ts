import { useEffect, useRef, useState } from 'react';
import type { RetrievalVerificationResult } from './retrievalVerification';

export interface OpeningRetrievalCheck {
  completedAt: string;
  result: RetrievalVerificationResult;
}

export function useOpeningRetrievalCheck(authenticated: boolean): OpeningRetrievalCheck | null {
  const task = useRef<Promise<OpeningRetrievalCheck> | null>(null);
  const [completed, setCompleted] = useState<OpeningRetrievalCheck | null>(null);

  useEffect(() => {
    if (!authenticated) return;
    let observing = true;
    // A fresh app document has a fresh opening. Keep the promise through effect
    // replay, view changes, session reset and reauthentication in this document.
    task.current ??= import('./retrievalVerification')
      .then(({ runRetrievalVerification }) => runRetrievalVerification(crypto.randomUUID()))
      .catch((): RetrievalVerificationResult => ({
        status: 'Incomplete',
        reason: 'Acquisition did not complete',
        durationMs: 0,
      }))
      .then(result => ({ completedAt: new Date().toISOString(), result }));

    void task.current.then(check => {
      if (observing) setCompleted(check);
    });
    return () => { observing = false; };
  }, [authenticated]);

  return authenticated ? completed : null;
}
