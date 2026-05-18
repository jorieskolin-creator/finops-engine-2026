import { requireSession } from "../lib/auth.js";
import { getInternalModelResult } from "../lib/internalModelResults.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { internalCallId } = req.body || {};
  if (!internalCallId || typeof internalCallId !== 'string') {
    return res.status(400).json({ error: 'Missing required field: internalCallId' });
  }

  const result = getInternalModelResult(internalCallId);
  if (!result) {
    return res.status(404).json({ status: 'missing' });
  }
  if (result.status === 'pending') {
    return res.status(200).json({ status: 'pending' });
  }
  if (result.status === 'error') {
    return res.status(200).json({ status: 'error', message: result.message || 'model call failed' });
  }
  return res.status(200).json({
    status: 'done',
    text: result.text || '',
    usage: result.usage || null,
  });
}
