export type PdfParseQualityLevel = 'good' | 'mixed' | 'poor';

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
  warnings: string[];
}

const SPARSE_CHAR_THRESHOLD = 250;
const SPARSE_WORD_THRESHOLD = 35;
const SPARSE_ITEM_THRESHOLD = 8;
const NEAR_ZERO_CHAR_THRESHOLD = 40;
const NEAR_ZERO_WORD_THRESHOLD = 5;
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
    && stats.textItemCount < 3;
};

export const assessPdfParseQuality = (input: {
  pages: PdfPageParseStats[];
  visualPagesIncluded: number;
  visualPagesSkipped: number;
  truncatedTextPages?: boolean;
  imageBudgetReached?: boolean;
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

  let quality: PdfParseQualityLevel = 'good';
  if (likelyScannedPdf || sparseRatio >= POOR_SPARSE_RATIO) {
    quality = 'poor';
  } else if (sparseRatio >= MIXED_SPARSE_RATIO || input.visualPagesSkipped > 0 || input.truncatedTextPages) {
    quality = 'mixed';
  }

  const warnings: string[] = [];
  if (quality === 'mixed') {
    warnings.push('Some PDF pages appeared image-heavy or sparse-text; visual pages were selectively included.');
  }
  if (quality === 'poor') {
    warnings.push('PDF appears scanned or image-heavy; source coverage may depend on visual interpretation.');
  }
  if (input.visualPagesSkipped > 0) {
    warnings.push(`${input.visualPagesSkipped} visual candidate page(s) were not included because the image budget was reached or rendering failed.`);
  }
  if (input.truncatedTextPages) {
    warnings.push('PDF text extraction was capped before the end of the document.');
  }
  if (input.imageBudgetReached) {
    warnings.push('PDF visual page extraction reached the encoded image budget.');
  }

  return {
    quality,
    textCoverageRatio,
    sparseTextPages,
    visualPagesIncluded: input.visualPagesIncluded,
    visualPagesSkipped: input.visualPagesSkipped,
    likelyScannedPdf,
    warnings
  };
};
