
import * as pdfjsLib from 'pdfjs-dist';
import type { PdfPageAcquisitionState, SourcePage, VisualEvidenceUnit } from '../types';
import { assessPdfParseQuality, isNearZeroPdfPage, isSparsePdfPage } from './parseQualityService';
import type { PdfPageParseStats, PdfParseQuality } from './parseQualityService';
import { createLocalOcrSession } from './ocrService';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export const extractTextFromPdf = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    pages.push(text);
  }

  return pages.join('\n\n');
};

const DEFAULT_MAX_TEXT_PAGES = 100;
const MAX_PDF_OCR_PAGES = 30;
const MAX_RENDERED_OCR_PIXELS = 20_000_000;
const PDF_OCR_SCALE = 2;
const MATERIAL_RASTER_PIXELS = 100_000;
const MIN_REQUIRED_OCR_CONFIDENCE = 55;

export type { PdfParseQuality } from './parseQualityService';

export interface PdfExtractionResult {
  text: string;
  pages: SourcePage[];
  visualUnits: VisualEvidenceUnit[];
  metadata: {
    totalPages: number;
    parsedTextPages: number;
    parseQuality: PdfParseQuality;
    warnings: string[];
  };
}

const renderPageForOcr = async (page: any): Promise<{ blob: Blob; width: number; height: number }> => {
  const initial = page.getViewport({ scale: PDF_OCR_SCALE });
  const pixelScale = Math.min(1, Math.sqrt(MAX_RENDERED_OCR_PIXELS / (initial.width * initial.height)));
  const viewport = pixelScale < 1 ? page.getViewport({ scale: PDF_OCR_SCALE * pixelScale }) : initial;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('PDF_OCR_CANVAS_UNAVAILABLE');
  await page.render({ canvasContext: context, viewport }).promise;
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error('PDF_OCR_RENDER_FAILED')),
    'image/png'
  ));
  return { blob, width: canvas.width, height: canvas.height };
};

const combineNativeAndOcrText = (nativeText: string, ocrText: string): string => {
  const native = nativeText.replace(/\s+/g, ' ').trim();
  const ocr = ocrText.replace(/\s+/g, ' ').trim();
  if (!native) return ocr;
  if (!ocr) return native;
  const normalizedNative = native.toLocaleLowerCase();
  const normalizedOcr = ocr.toLocaleLowerCase();
  if (normalizedNative.includes(normalizedOcr)) return native;
  if (normalizedOcr.includes(normalizedNative)) return ocr;
  return `${native}\n\n[LOCAL_OCR_TEXT]\n${ocr}`;
};

const hasMaterialRasterImage = async (page: any): Promise<boolean> => {
  const operators = await page.getOperatorList();
  return operators.fnArray.some((operator: number, index: number) => {
    if (![pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintImageXObjectRepeat].includes(operator)) return false;
    const args = operators.argsArray[index] || [];
    const width = Number(args[1] ?? args[0]?.width);
    const height = Number(args[2] ?? args[0]?.height);
    return Number.isFinite(width) && Number.isFinite(height) && width * height >= MATERIAL_RASTER_PIXELS;
  });
};

export const extractPagesFromPdf = async (
  file: File,
  opts?: { maxTextPages?: number; sourceHash?: string }
): Promise<PdfExtractionResult> => {
  const maxTextPages = opts?.maxTextPages ?? DEFAULT_MAX_TEXT_PAGES;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts: string[] = [];
  const loadedPages: any[] = [];
  const sourcePages: SourcePage[] = [];
  const visualUnits: VisualEvidenceUnit[] = [];
  const warnings: string[] = [];
  const pageCount = Math.min(pdf.numPages, maxTextPages);
  const pageStats: PdfPageParseStats[] = [];
  const materialRasterPages = new Set<number>();

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    loadedPages.push(page);
    if (await hasMaterialRasterImage(page)) materialRasterPages.add(i);
    const content = await page.getTextContent();
    const textItems = content.items.map((item: any) => String(item.str || ''));
    const text = textItems.join(' ');
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    pageStats.push({
      pageNumber: i,
      charCount: normalizedText.length,
      wordCount: normalizedText.length > 0 ? normalizedText.split(/\s+/).length : 0,
      textItemCount: textItems.filter((item: string) => item.trim().length > 0).length
    });
    pageTexts.push(text);
  }

  const ocrPageNumbers = pageStats
    .filter(stats => isSparsePdfPage(stats) || materialRasterPages.has(stats.pageNumber))
    .map(stats => stats.pageNumber);
  if (ocrPageNumbers.length > MAX_PDF_OCR_PAGES) throw new Error('PDF_OCR_PAGE_LIMIT_EXCEEDED');
  let ocrSession: Awaited<ReturnType<typeof createLocalOcrSession>> | undefined;
  const pageStates: Array<{ pageNumber: number; state: PdfPageAcquisitionState }> = [];
  try {
    for (let index = 0; index < pageCount; index++) {
      const pageNumber = index + 1;
      const stats = pageStats[index];
      const nativeText = pageTexts[index];
      let finalText = nativeText;
      let state: PdfPageAcquisitionState = 'TEXT_EXTRACTED';
      const sparsePage = isSparsePdfPage(stats);
      if (sparsePage || materialRasterPages.has(pageNumber)) {
        state = 'OCR_REQUIRED';
        try {
          ocrSession ||= await createLocalOcrSession();
          const rendered = await renderPageForOcr(loadedPages[index]);
          const visualUnit = await ocrSession.recognize(
            rendered.blob,
            opts?.sourceHash || 'unhashed-pdf',
            { width: rendered.width, height: rendered.height },
            `p${String(pageNumber).padStart(3, '0')}`,
            pageNumber
          );
          if (visualUnit.confidence < MIN_REQUIRED_OCR_CONFIDENCE || visualUnit.words.length === 0) {
            throw new Error('PDF_OCR_INSUFFICIENT_CONFIDENCE_OR_GEOMETRY');
          }
          visualUnits.push(visualUnit);
          if (visualUnit.confidence < 70) warnings.push(`PDF page ${pageNumber} local OCR confidence was ${visualUnit.confidence.toFixed(1)}; use extracted text cautiously.`);
          finalText = combineNativeAndOcrText(nativeText, visualUnit.text);
          state = 'OCR_COMPLETE';
        } catch {
          await ocrSession?.terminate();
          ocrSession = undefined;
          if (isNearZeroPdfPage(stats)) throw new Error(`PDF_REQUIRED_PAGE_OCR_FAILED_${pageNumber}`);
          state = sparsePage ? 'SPARSE_TEXT_ONLY' : 'VISUAL_REGION_WITHHELD';
          warnings.push(`PDF page ${pageNumber} retained native text after local OCR was unavailable; material visual semantics remain withheld.`);
        }
      }
      pageTexts[index] = finalText;
      pageStates.push({ pageNumber, state });
      sourcePages.push({
        schema_version: 'source_page_v1',
        page_id: `page-${pageNumber}`,
        page_number: pageNumber,
        text: finalText,
        acquisition_state: state
      });
    }
  } finally {
    await ocrSession?.terminate();
  }

  if (pdf.numPages > maxTextPages) {
    const warning = `PDF has ${pdf.numPages} pages; text extraction was capped at the first ${maxTextPages} pages.`;
    warnings.push(warning);
    console.warn(`[pdfService] Text extraction capped pages=${pdf.numPages} max_text_pages=${maxTextPages}; filename omitted.`);
  }

  const parseQuality = assessPdfParseQuality({
    pages: pageStats,
    visualPagesIncluded: visualUnits.length,
    visualPagesSkipped: pageStates.filter(page => page.state === 'SPARSE_TEXT_ONLY' || page.state === 'VISUAL_REGION_WITHHELD').length,
    truncatedTextPages: pdf.numPages > maxTextPages,
    imageBudgetReached: false,
    pageStates
  });
  warnings.push(...parseQuality.warnings);
  if (visualUnits.length > 0) {
    warnings.push(`Local OCR completed for ${visualUnits.length} sparse or image-heavy PDF page(s). OCR text is acquired evidence; graph structure and other non-text visual semantics remain withheld.`);
  }

  if (pageTexts.every(text => text.trim().length === 0)) throw new Error('PDF_NO_EXTRACTABLE_TEXT');

  return {
    text: pageTexts.join('\n\n'),
    pages: sourcePages,
    visualUnits,
    metadata: {
      totalPages: pdf.numPages,
      parsedTextPages: sourcePages.filter(page => page.text.trim().length > 0).length,
      parseQuality,
      warnings
    }
  };
};
