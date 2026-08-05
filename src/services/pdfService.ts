
import * as pdfjsLib from 'pdfjs-dist';
import type { SourcePage } from '../types';
import { assessPdfParseQuality } from './parseQualityService';
import type { PdfPageParseStats, PdfParseQuality } from './parseQualityService';

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

export type { PdfParseQuality } from './parseQualityService';

export interface PdfExtractionResult {
  text: string;
  pages: SourcePage[];
  metadata: {
    totalPages: number;
    parsedTextPages: number;
    parseQuality: PdfParseQuality;
    warnings: string[];
  };
}

export const extractPagesFromPdf = async (
  file: File,
  opts?: { maxTextPages?: number }
): Promise<PdfExtractionResult> => {
  const maxTextPages = opts?.maxTextPages ?? DEFAULT_MAX_TEXT_PAGES;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts: string[] = [];
  const warnings: string[] = [];
  const pageCount = Math.min(pdf.numPages, maxTextPages);
  const pageStats: PdfPageParseStats[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

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

  if (pdf.numPages > maxTextPages) {
    const warning = `${file.name} has ${pdf.numPages} pages; text extraction was capped at the first ${maxTextPages} pages.`;
    warnings.push(warning);
    console.warn(`[pdfService] Text extraction capped pages=${pdf.numPages} max_text_pages=${maxTextPages}; filename omitted.`);
  }

  const parseQuality = assessPdfParseQuality({
    pages: pageStats,
    visualPagesIncluded: 0,
    visualPagesSkipped: 0,
    truncatedTextPages: pdf.numPages > maxTextPages,
    imageBudgetReached: false
  });
  warnings.push(...parseQuality.warnings);

  if (pageStats.every(stats => stats.charCount === 0)) {
    throw new Error(`File ${file.name} has no extractable text. Local OCR is unavailable, so scanned or visual-only PDF pages cannot be processed.`);
  }

  return {
    text: pageTexts.join('\n\n'),
    pages: pageTexts.map((text,index) => ({ schema_version:'source_page_v1', page_id:`page-${index+1}`, page_number:index+1, text })),
    metadata: {
      totalPages: pdf.numPages,
      parsedTextPages: pageCount,
      parseQuality,
      warnings
    }
  };
};
