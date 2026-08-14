import type { VisualEvidenceUnit } from '../types';

const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_DIMENSION = 10_000;
const OCR_TIMEOUT_MS = 90_000;

type OcrWordLike = { text?: string; confidence?: number; bbox?: { x0?: number; y0?: number; x1?: number; y1?: number } };

const nestedWords = (blocks: any): OcrWordLike[] => (Array.isArray(blocks) ? blocks : []).flatMap((block: any) =>
  (block.paragraphs || []).flatMap((paragraph: any) =>
    (paragraph.lines || []).flatMap((line: any) => line.words || [])
  )
);

export const normalizeOcrResult = (input: {
  sourceHash: string;
  unitSuffix?: string;
  pageNumber?: number;
  width: number;
  height: number;
  text?: string;
  confidence?: number;
  blocks?: unknown;
}): VisualEvidenceUnit => ({
  schema_version: 'visual_evidence_unit_v1',
  unit_id: `visual-${input.sourceHash.replace(/^sha256_/, '').slice(0, 24)}${input.unitSuffix ? `-${input.unitSuffix}` : ''}`,
  page_number: input.pageNumber,
  extraction_method: 'local_ocr',
  engine_version: 'tesseract.js@7.0.0',
  language: 'eng+fin',
  width: input.width,
  height: input.height,
  confidence: Number.isFinite(input.confidence) ? Math.max(0, Math.min(100, input.confidence!)) : 0,
  text: (input.text || '').replace(/\s+/g, ' ').trim(),
  words: nestedWords(input.blocks).flatMap(word => {
    const text = (word.text || '').trim();
    const box = word.bbox;
    if (!text || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) return [];
    return [{
      text,
      confidence: Number.isFinite(word.confidence) ? Math.max(0, Math.min(100, word.confidence!)) : 0,
      bounding_box: { x0: box.x0!, y0: box.y0!, x1: box.x1!, y1: box.y1! }
    }];
  }),
  post_ocr_redaction_status: 'PENDING',
  visual_interpretation_status: 'OCR_TEXT_ONLY',
  withheld_regions: [{
    bounding_box: { x0: 0, y0: 0, x1: input.width, y1: input.height },
    reason: 'UNINSPECTED_VISUAL_REGION'
  }]
});

const imageDimensions = async (file: File): Promise<{ width: number; height: number }> => {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0
      || bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION
      || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      throw new Error('IMAGE_PIXEL_LIMIT_EXCEEDED');
    }
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

export const extractImageOcr = async (file: File, sourceHash: string): Promise<VisualEvidenceUnit> => {
  const dimensions = await imageDimensions(file);
  const session = await createLocalOcrSession();
  try {
    return await session.recognize(file, sourceHash, dimensions);
  } finally {
    await session.terminate();
  }
};

export const createLocalOcrSession = async (): Promise<{
  recognize: (
    image: Blob,
    sourceHash: string,
    dimensions: { width: number; height: number },
    unitSuffix?: string,
    pageNumber?: number
  ) => Promise<VisualEvidenceUnit>;
  terminate: () => Promise<unknown>;
}> => {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['eng', 'fin'], 1, {
    workerPath: '/ocr-assets/worker.min.js',
    corePath: '/ocr-assets/core',
    langPath: '/ocr-assets/lang'
  });
  return {
    recognize: async (image, sourceHash, dimensions, unitSuffix, pageNumber) => {
      let timeout: number | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('OCR_WORKER_TIMEOUT')), OCR_TIMEOUT_MS);
        });
        const recognition = worker.recognize(image, {}, { text: true, blocks: true });
        const result = await Promise.race([recognition, timedOut]);
        const unit = normalizeOcrResult({
          sourceHash,
          unitSuffix,
          pageNumber,
          ...dimensions,
          text: result.data.text,
          confidence: result.data.confidence,
          blocks: result.data.blocks
        });
        if (!unit.text) throw new Error('OCR_NO_TEXT_DETECTED');
        return unit;
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
      }
    },
    terminate: () => worker.terminate()
  };
};
