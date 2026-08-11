import { requireSession } from '../lib/auth.js';
import { buildKbStatus, sanitizeKbDocument } from '../lib/kbIndex.js';
import { createHash } from 'node:crypto';

const BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '12';
const DEFAULT_PREFIX = 'Knowledge Base/';
const CACHE_TTL_MS = 45 * 60 * 1000;
const CACHE_FAILURE_TTL_MS = 30 * 1000;
const MAX_BLOBS = 300;
const PDF_TEXT_PAGE_LIMIT = 100;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_DOCUMENT_CHARS = 750_000;
const MAX_INDEX_CHARS = 8_000_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

let cache = null;
let refreshPromise = null;
let lastRefreshAttemptAt = 0;
const documentCache = new Map();

const sha256 = value => `sha256_${createHash('sha256').update(value).digest('hex')}`;

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

export async function listBlobPdfs({ token, prefix }) {
  const blobs = [];
  let cursor = undefined;
  let limitReached = false;
  let listedCount = 0;
  do {
    const params = new URLSearchParams({ limit: '100', prefix });
    if (cursor) params.set('cursor', cursor);
    const data = await fetchAndConsume(`${BLOB_API_URL}?${params.toString()}`, {
      method: 'GET', headers: blobHeaders(token),
    }, async response => {
      if (!response.ok) throw new Error(`Vercel Blob list failed: HTTP ${response.status}`);
      return response.json();
    });
    const pageBlobs = Array.isArray(data?.blobs) ? data.blobs : [];
    for (const blob of pageBlobs) {
      listedCount++;
      if (listedCount > MAX_BLOBS) {
        limitReached = true;
        break;
      }
      if (String(blob?.pathname || '').toLowerCase().endsWith('.pdf')) {
        blobs.push(blob);
      }
    }
    cursor = !limitReached && data?.hasMore ? data?.cursor : undefined;
  } while (cursor);
  return { blobs, limitReached };
}

async function fetchAndConsume(url, options, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('KB_UPSTREAM_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const pdf = await pdfjs.getDocument({ data, disableWorker: true }).promise;
  try {
    const pageCount = Math.min(pdf.numPages, PDF_TEXT_PAGE_LIMIT);
    const pages = [];
    const sectionPages = [];
    const sparsePages = [];
    let extractedChars = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const legacyText = content.items
          .map(item => typeof item?.str === 'string' ? item.str : '')
          .join(' ')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        const lines = [];
        let currentLine = '';
        for (const item of content.items) {
          const value = typeof item?.str === 'string' ? item.str.trim() : '';
          if (value) currentLine += `${currentLine ? ' ' : ''}${value}`;
          if (item?.hasEOL) {
            if (currentLine) lines.push(currentLine.replace(/[ \t]{2,}/g, ' ').trim());
            currentLine = '';
          }
        }
        if (currentLine) lines.push(currentLine.replace(/[ \t]{2,}/g, ' ').trim());
        const sectionText = lines.join('\n').trim();
        extractedChars += sectionText.length;
        if (extractedChars > MAX_EXTRACTED_DOCUMENT_CHARS) {
          throw new Error('KB_EXTRACTED_TEXT_LIMIT_EXCEEDED');
        }
        if (sectionText.length < 40) sparsePages.push(pageNumber);
        pages.push(`[KB_PDF_PAGE page="${pageNumber}"]\n${legacyText}\n[/KB_PDF_PAGE]`);
        sectionPages.push(`[KB_PDF_PAGE page="${pageNumber}"]\n${sectionText}\n[/KB_PDF_PAGE]`);
      } finally {
        page.cleanup();
      }
    }
    return {
      text: pages.join('\n\n'),
      sectionText: sectionPages.join('\n\n'),
      totalPages: pdf.numPages,
      processedPages: pageCount,
      sparsePages,
      pageLimitReached: pdf.numPages > pageCount,
    };
  } finally {
    await pdf.destroy();
  }
}

export async function fetchBlobBytes(blob, token) {
  const url = blob.downloadUrl || blob.url;
  if (!url) throw new Error('blob has no url/downloadUrl');
  if (Number(blob.size) > MAX_PDF_BYTES) throw new Error('KB_PDF_BYTE_LIMIT_EXCEEDED');
  return fetchAndConsume(url, {
    method: 'GET', headers: { authorization: `Bearer ${token}` },
  }, async response => {
    if (!response.ok) {
      throw new Error(`PDF fetch failed: HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_PDF_BYTES) throw new Error('KB_PDF_BYTE_LIMIT_EXCEEDED');
    if (!response.body) throw new Error('PDF fetch returned no body');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PDF_BYTES) throw new Error('KB_PDF_BYTE_LIMIT_EXCEEDED');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  });
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
  const listed = await listBlobPdfs({ token, prefix });
  const blobs = listed.blobs;
  const listedPathnames = new Set(blobs.map(blob => blob.pathname));
  for (const pathname of documentCache.keys()) {
    if (!listedPathnames.has(pathname)) documentCache.delete(pathname);
  }
  if (listed.limitReached) failures.push({ pathname: prefix, reason: 'KB_BLOB_COUNT_LIMIT_EXCEEDED' });
  let indexChars = 0;

  for (const blob of blobs) {
    try {
      const bytes = await fetchBlobBytes(blob, token);
      const pdfBytes = Buffer.from(bytes);
      const pdfSha256 = sha256(pdfBytes);
      const cachedDocument = documentCache.get(blob.pathname);
      if (cachedDocument?.pdfSha256 === pdfSha256) {
        const documentChars = JSON.stringify(cachedDocument.document).length;
        if (indexChars + documentChars > MAX_INDEX_CHARS) {
          failures.push({ pathname: blob.pathname, reason: 'KB_INDEX_CHARACTER_LIMIT_EXCEEDED' });
          break;
        }
        documents.push(cachedDocument.document);
        indexChars += documentChars;
        continue;
      }
      const extraction = await extractPdfText(bytes);
      const document = sanitizeKbDocument({
        pathname: blob.pathname,
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
        text: extraction.text,
        sectionText: extraction.sectionText,
        pdfSha256,
        extractedTextSha256: sha256(extraction.sectionText),
        extraction,
      });
      const documentChars = JSON.stringify(document).length;
      if (indexChars + documentChars > MAX_INDEX_CHARS) {
        failures.push({ pathname: blob.pathname, reason: 'KB_INDEX_CHARACTER_LIMIT_EXCEEDED' });
        break;
      }
      indexChars += documentChars;
      documentCache.set(blob.pathname, { pdfSha256, document });
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
  const cacheIsHealthy = cache?.payload?.status?.source === 'remote_blob'
    && cache?.payload?.status?.failure_count === 0;
  const cacheTtl = cacheIsHealthy ? CACHE_TTL_MS : CACHE_FAILURE_TTL_MS;
  if (cache && now - cache.createdAt < cacheTtl) {
    return res.status(200).json({ ...cache.payload, cached: true });
  }
  if (cacheIsHealthy && now - lastRefreshAttemptAt < CACHE_FAILURE_TTL_MS) {
    return res.status(200).json({ ...cache.payload, cached: true, stale: true });
  }

  try {
    if (!refreshPromise) {
      lastRefreshAttemptAt = now;
      refreshPromise = buildRemoteIndex().finally(() => { refreshPromise = null; });
    }
    const payload = await refreshPromise;
    const payloadIsHealthy = payload.status?.source === 'remote_blob'
      && payload.status?.failure_count === 0;
    if (!payloadIsHealthy && cacheIsHealthy) {
      return res.status(200).json({ ...cache.payload, cached: true, stale: true });
    }
    cache = { createdAt: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false });
  } catch (error) {
    const reason = error?.message || String(error);
    console.error('[FinOps KnowledgeBase] event=kb_index_fallback error_code=KB_INDEX_FAILED');
    if (cacheIsHealthy) {
      return res.status(200).json({ ...cache.payload, cached: true, stale: true });
    }
    const prefix = normalizePrefix(process.env.FINOPS_KB_BLOB_PREFIX || DEFAULT_PREFIX);
    const failures = [{ pathname: prefix, reason }];
    const payload = {
      status: buildKbStatus([], failures, 'fallback', prefix),
      documents: [],
      failures,
    };
    cache = { createdAt: Date.now(), payload };
    return res.status(200).json({ ...payload, cached: false });
  }
}
