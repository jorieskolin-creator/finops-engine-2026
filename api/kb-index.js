import { requireSession } from '../lib/auth.js';
import { buildKbStatus, sanitizeKbDocument } from '../lib/kbIndex.js';

const BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '12';
const DEFAULT_PREFIX = 'Knowledge Base/';
const CACHE_TTL_MS = 45 * 60 * 1000;
const MAX_BLOBS = 300;
const PDF_TEXT_PAGE_LIMIT = 40;

let cache = null;

const parseStoreIdFromReadWriteToken = (token) => {
  const [, , , storeId = ''] = String(token || '').split('_');
  return storeId;
};

const normalizePrefix = (prefix) => {
  const value = String(prefix || DEFAULT_PREFIX).trim();
  return value.endsWith('/') ? value : `${value}/`;
};

const blobHeaders = (token) => {
  const storeId = parseStoreIdFromReadWriteToken(token);
  return {
    authorization: `Bearer ${token}`,
    'x-vercel-blob-store-id': storeId,
    'x-api-version': BLOB_API_VERSION,
  };
};

async function listBlobPdfs({ token, prefix }) {
  const blobs = [];
  let cursor = undefined;
  do {
    const params = new URLSearchParams({ limit: '100', prefix });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`${BLOB_API_URL}?${params.toString()}`, {
      method: 'GET',
      headers: blobHeaders(token),
    });
    if (!response.ok) {
      throw new Error(`Vercel Blob list failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    const pageBlobs = Array.isArray(data?.blobs) ? data.blobs : [];
    for (const blob of pageBlobs) {
      if (String(blob?.pathname || '').toLowerCase().endsWith('.pdf')) {
        blobs.push(blob);
      }
    }
    cursor = data?.hasMore ? data?.cursor : undefined;
  } while (cursor && blobs.length < MAX_BLOBS);
  return blobs;
}

async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const pdf = await pdfjs.getDocument({ data, disableWorker: true }).promise;
  const pageCount = Math.min(pdf.numPages, PDF_TEXT_PAGE_LIMIT);
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => typeof item?.str === 'string' ? item.str : '')
      .join(' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    pages.push(`[KB_PDF_PAGE page="${pageNumber}"]\n${text}\n[/KB_PDF_PAGE]`);
  }
  return pages.join('\n\n');
}

async function fetchBlobBytes(blob, token) {
  const url = blob.downloadUrl || blob.url;
  if (!url) throw new Error('blob has no url/downloadUrl');
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`PDF fetch failed: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

async function buildRemoteIndex() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const prefix = normalizePrefix(process.env.FINOPS_KB_BLOB_PREFIX || DEFAULT_PREFIX);
  if (!token) {
    const failures = [{ pathname: prefix, reason: 'BLOB_READ_WRITE_TOKEN is not configured' }];
    console.info('[FinOps KnowledgeBase] event=kb_index_fallback error_code=BLOB_TOKEN_MISSING');
    return {
      status: buildKbStatus([], failures, 'fallback', prefix),
      documents: [],
      failures,
    };
  }

  const failures = [];
  const documents = [];
  const blobs = await listBlobPdfs({ token, prefix });

  for (const blob of blobs) {
    try {
      const bytes = await fetchBlobBytes(blob, token);
      const text = await extractPdfText(bytes);
      const document = sanitizeKbDocument({
        pathname: blob.pathname,
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
        text,
      });
      documents.push(document);
    } catch (error) {
      const reason = error?.message || String(error);
      failures.push({ pathname: blob.pathname || '(unknown)', reason });
      console.warn('[FinOps KnowledgeBase] event=kb_document_invalid error_code=KB_DOCUMENT_INVALID');
    }
  }

  documents.sort((a, b) => String(a.criterion_id).localeCompare(String(b.criterion_id)));
  const status = buildKbStatus(documents, failures, documents.length > 0 ? 'remote_blob' : 'fallback', prefix);
  if (documents.length > 0) {
    console.info(`[FinOps KnowledgeBase] event=kb_index_loaded documents=${documents.length} failures=${failures.length}`);
  } else {
    console.info(`[FinOps KnowledgeBase] event=kb_index_fallback error_code=NO_VALID_DOCUMENTS failures=${failures.length}`);
  }
  return { status, documents, failures };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const now = Date.now();
  if (cache && now - cache.createdAt < CACHE_TTL_MS) {
    return res.status(200).json({ ...cache.payload, cached: true });
  }

  try {
    const payload = await buildRemoteIndex();
    cache = { createdAt: now, payload };
    return res.status(200).json({ ...payload, cached: false });
  } catch (error) {
    const reason = error?.message || String(error);
    console.error('[FinOps KnowledgeBase] event=kb_index_fallback error_code=KB_INDEX_FAILED');
    const prefix = normalizePrefix(process.env.FINOPS_KB_BLOB_PREFIX || DEFAULT_PREFIX);
    const failures = [{ pathname: prefix, reason }];
    const payload = {
      status: buildKbStatus([], failures, 'fallback', prefix),
      documents: [],
      failures,
    };
    cache = { createdAt: now, payload };
    return res.status(200).json({ ...payload, cached: false });
  }
}
