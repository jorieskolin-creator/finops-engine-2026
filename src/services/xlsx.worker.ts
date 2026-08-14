/// <reference lib="webworker" />

import { parseXlsxBytes } from './xlsxCore';

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; sourceHash: string }>) => {
  try {
    const result = await parseXlsxBytes(new Uint8Array(event.data.bytes), event.data.sourceHash);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'XLSX_EXTRACTION_FAILED' });
  }
};

export {};
