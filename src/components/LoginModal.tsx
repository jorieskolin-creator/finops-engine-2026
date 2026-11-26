import React, { useEffect, useRef, useState } from 'react';
import { login } from '../services/authService';

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ open, onClose, onSuccess }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    const result = await login(password);
    setBusy(false);
    if (result.ok) {
      onSuccess();
    } else {
      setError(result.error);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-finops-ink/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        className="finops-card mx-4 w-full max-w-md p-6 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="unlock-title" className="mb-2 text-xl font-bold">Unlock assessment</h2>
        <p className="mb-6 text-sm text-finops-muted">
          The assessment runs against paid AI APIs. Enter the access password to continue.
        </p>
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Access password"
            autoComplete="current-password"
            className="finops-field w-full"
            disabled={busy}
          />
          {error && (
            <div role="alert" className="mt-3 text-sm text-rose-800">{error}</div>
          )}
          <div className="mt-6 flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="finops-button"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !password}
              className="finops-primary"
            >
              {busy ? 'Signing in…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
