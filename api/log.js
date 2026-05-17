// Minimal client→server logger. The client posts pipeline events here so
// they appear in Railway's log stream alongside the proxy call logs.
// Session-gated so random scanners can't pollute the logs.

import { requireSession } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { runId, level, event, ...rest } = req.body || {};
  const ts = new Date().toISOString();
  const tag = `[${ts}] [run=${runId || '?'}]`;
  const line = `${tag} event=${event || 'unknown'} ${formatFields(rest)}`;

  if (level === 'error') console.error(line);
  else console.log(level === 'warn' ? `${line} level=warn` : line);

  return res.status(204).end();
}

function formatFields(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
}
