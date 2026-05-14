// Shared auth helpers for the Vercel/Node serverless functions. Pure node:crypto,
// no external dependencies, so the app stays portable beyond Vercel.
//
// Session cookie format: `<base64url(payload)>.<base64url(hmac)>` where the
// HMAC is keyed by SECRET_KEY. SECRET_KEY serves dual duty as the login
// password AND the signing key — rotating it invalidates all sessions, which
// is the desired behavior for a single-secret app.

import crypto from 'node:crypto';

const COOKIE_NAME = 'fe_session';
const TTL_SECONDS = 60 * 60 * 8; // 8h

function getSecret() {
  const secret = process.env.SECRET_KEY;
  if (!secret) throw new Error('SECRET_KEY not configured');
  return secret;
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkPassword(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = getSecret();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function issueCookie(role = 'user') {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = sign({ exp, role });
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function requireSession(req) {
  const cookieHeader = req.headers?.cookie || '';
  const target = `${COOKIE_NAME}=`;
  const match = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(target));
  if (!match) return null;
  return verify(match.slice(target.length));
}
