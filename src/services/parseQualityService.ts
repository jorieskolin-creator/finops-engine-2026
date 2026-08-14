export type PdfParseQualityLevel = 'good' | 'mixed' | 'poor';
import type { PdfPageAcquisitionState } from '../types';

export interface PdfPageParseStats {
  pageNumber: number;
  charCount: number;
  wordCount: number;
  textItemCount: number;
}

export interface PdfParseQuality {
  quality: PdfParseQualityLevel;
  textCoverageRatio: number;
  sparseTextPages: number;
  visualPagesIncluded: number;
  visualPagesSkipped: number;
  likelyScannedPdf: boolean;
  pageStates?: Array<{ pageNumber: number; state: PdfPageAcquisitionState }>;
  warnings: string[];
}

const SPARSE_CHAR_THRESHOLD = 250;
const SPARSE_WORD_THRESHOLD = 35;
const SPARSE_ITEM_THRESHOLD = 8;
const NEAR_ZERO_CHAR_THRESHOLD = 40;
const NEAR_ZERO_WORD_THRESHOLD = 5;
const NEAR_ZERO_ITEM_THRESHOLD = 3;
const SCANNED_PAGE_RATIO = 0.6;
const MIXED_SPARSE_RATIO = 0.2;
const POOR_SPARSE_RATIO = 0.5;

export const isSparsePdfPage = (stats: PdfPageParseStats): boolean => {
  return stats.charCount < SPARSE_CHAR_THRESHOLD
    || stats.wordCount < SPARSE_WORD_THRESHOLD
    || stats.textItemCount < SPARSE_ITEM_THRESHOLD;
};

export const isNearZeroPdfPage = (stats: PdfPageParseStats): boolean => {
  return stats.charCount < NEAR_ZERO_CHAR_THRESHOLD
    && stats.wordCount < NEAR_ZERO_WORD_THRESHOLD
    && stats.textItemCount < NEAR_ZERO_ITEM_THRESHOLD;
};

export const assessPdfParseQuality = (input: {
  pages: PdfPageParseStats[];
  visualPagesIncluded: number;
  visualPagesSkipped: number;
  truncatedTextPages?: boolean;
  imageBudgetReached?: boolean;
  pageStates?: Array<{ pageNumber: number; state: PdfPageAcquisitionState }>;
}): PdfParseQuality => {
  const totalPages = input.pages.length;
  if (totalPages === 0) {
    return {
      quality: 'poor',
      textCoverageRatio: 0,
      sparseTextPages: 0,
      visualPagesIncluded: input.visualPagesIncluded,
      visualPagesSkipped: input.visualPagesSkipped,
      likelyScannedPdf: true,
      warnings: ['PDF text extraction returned no readable pages.']
    };
  }

  const sparseTextPages = input.pages.filter(isSparsePdfPage).length;
  const nearZeroPages = input.pages.filter(isNearZeroPdfPage).length;
  const textCoverageRatio = Math.round(((totalPages - sparseTextPages) / totalPages) * 100) / 100;
  const sparseRatio = sparseTextPages / totalPages;
  const nearZeroRatio = nearZeroPages / totalPages;
  const likelyScannedPdf = nearZeroRatio >= SCANNED_PAGE_RATIO;

  const pageStates = input.pageStates;
  const unresolvedRequiredPage = pageStates?.some(page => page.state === 'OCR_REQUIRED' || page.state === 'VISUAL_REGION_WITHHELD' || page.state === 'EXTRACTION_FAILED');
  const unresolvedSparsePages = pageStates?.filter(page => page.state === 'SPARSE_TEXT_ONLY').length || 0;
  const declaredVisualLimitation = pageStates?.some(page => page.state === 'VISUAL_INTERPRETATION_REQUIRED' || page.state === 'VISUAL_REGION_WITHHELD');
  let quality: PdfParseQualityLevel = 'good';
  if (pageStates) {
    if (unresolvedRequiredPage || input.truncatedTextPages
      || (unresolvedSparsePages > 1 && unresolvedSparsePages / totalPages >= MIXED_SPARSE_RATIO)) quality = 'poor';
    else if (declaredVisualLimitation || unresolvedSparsePages > 0 || input.visualPagesSkipped > 0) quality = 'mixed';
  } else if (likelyScannedPdf || sparseRatio >= POOR_SPARSE_RATIO) {
    quality = 'poor';
  } else if (sparseRatio >= MIXED_SPARSE_RATIO || input.visualPagesSkipped > 0 || input.truncatedTextPages) {
    quality = 'mixed';
  }

  const warnings: string[] = [];
  if (quality === 'mixed' && !pageStates) {
    warnings.push('Some PDF pages appeared image-heavy or sparse-text. Visual fallback is disabled; those pages were not visually inspected.');
  }
  if (quality === 'poor' && !pageStates) {
    warnings.push('PDF appears scanned or image-heavy. Visual fallback is disabled; sparse/scanned pages were not visually inspected.');
  }
  if (input.visualPagesSkipped > 0) {
    warnings.push(`${input.visualPagesSkipped} sparse visual candidate page(s) retained native text but could not complete local OCR.`);
  }
  if (input.truncatedTextPages) {
    warnings.push('PDF text extraction was capped before the end of the document.');
  }
  if (input.imageBudgetReached) {
    warnings.push('PDF image budget was not used because visual fallback is disabled.');
  }

  return {
    quality,
    textCoverageRatio,
    sparseTextPages,
    visualPagesIncluded: input.visualPagesIncluded,
    visualPagesSkipped: input.visualPagesSkipped,
    likelyScannedPdf,
    pageStates,
    warnings
  };
};
