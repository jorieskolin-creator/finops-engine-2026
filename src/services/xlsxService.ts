import type { XlsxExtractionResult } from './xlsxCore';

const XLSX_WORKER_TIMEOUT_MS = 20_000;

export const extractXlsx = async (file: File, sourceHash: string): Promise<XlsxExtractionResult> => {
  const bytes = await file.arrayBuffer();
  const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<XlsxExtractionResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('XLSX_WORKER_TIMEOUT'));
    }, XLSX_WORKER_TIMEOUT_MS);
    worker.onmessage = event => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data?.ok) resolve(event.data.result);
      else reject(new Error(event.data?.error || 'XLSX_EXTRACTION_FAILED'));
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error('XLSX_WORKER_FAILED'));
    };
    worker.postMessage({ bytes, sourceHash }, [bytes]);
  });
};
