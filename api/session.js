import { requireSession } from '../lib/auth.js';

export default async function handler(req, res) {
  const session = requireSession(req);
  if (!session) return res.status(401).json({ ok: false });
  return res.status(200).json({ ok: true, exp: session.exp });
}
