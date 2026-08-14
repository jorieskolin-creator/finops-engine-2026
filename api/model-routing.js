import { requireSession } from '../lib/auth.js';
import { resolveModelRouting } from '../lib/modelRoutingPolicy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!requireSession(req)) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
  try {
    return res.status(200).json(resolveModelRouting(process.env));
  } catch {
    return res.status(503).json({ error: 'MODEL_ROUTING_CONFIGURATION_INVALID' });
  }
}
