// Thin client wrapper around the /api/{login,logout,session} endpoints.
// The session cookie is HttpOnly, so JS can't read it — we just track a
// boolean derived from the latest endpoint response.

export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error || `Login failed (${res.status})` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // best-effort
  }
}
