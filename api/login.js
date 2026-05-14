import { checkPassword, issueCookie } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { password } = req.body || {};
    if (!checkPassword(password)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    res.setHeader('Set-Cookie', issueCookie());
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
