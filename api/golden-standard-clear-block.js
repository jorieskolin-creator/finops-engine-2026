import { requireSession } from '../lib/auth.js';
import { clearBlockCase, compareClearBlock, validClearBlockObservation } from '../lib/goldenStandardClearBlock.js';
import { workerOperationalLog } from '../lib/workerOperationalLog.js';

const safeReason = error => typeof error?.code === 'string' && /^GOLDEN_STANDARD_[A-Z0-9_]{1,48}$/.test(error.code)
  ? error.code
  : error?.message === 'GOLDEN_STANDARD_INTEGRITY' ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE';

export function clearBlockHandler(caseStore = clearBlockCase()) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!requireSession(req)) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    try {
      const keys = Object.keys(req.query ?? {});
      const slot = req.query?.input;
      if (req.method === 'GET' && keys.length === 0) {
        const [files] = await Promise.all([caseStore.loadInputs(), caseStore.loadReference()]);
        return res.status(200).json({ files: files.map(({ path, bytes, sha256 }) => ({ name: path.split('/').at(-1), bytes, sha256 })) });
      }
      if (req.method === 'GET' && keys.length === 1 && typeof slot === 'string' && /^[0-2]$/.test(slot)) {
        const entry = (await caseStore.loadInputs())[Number(slot)];
        if (!entry) return res.status(404).json({ error: 'GOLDEN_STANDARD_UNAVAILABLE', reason: 'GOLDEN_STANDARD_BLOB_NOT_FOUND' });
        const data = await caseStore.read(entry);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(data);
      }
      if (req.method === 'POST' && keys.length === 0 && validClearBlockObservation(req.body)) {
        return res.status(200).json(compareClearBlock(await caseStore.loadReference(), req.body));
      }
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    } catch (error) {
      const reason = safeReason(error);
      const code = reason === 'GOLDEN_STANDARD_INTEGRITY' ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE';
      workerOperationalLog('warn', 'golden_standard_event', {
        action: req.method === 'POST' ? 'clear_block_compare' : 'clear_block_input',
        case_id: 'clear-block',
        error_code: reason,
        http_status: error?.httpStatus,
        blob_source: error?.blobSource,
      });
      return res.status(503).json({ error: code, reason });
    }
  };
}

export default clearBlockHandler();
