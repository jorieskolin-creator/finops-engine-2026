import { extractPagesFromPdf } from './pdfService';
import type { PdfParseQuality } from './pdfService';
import { renderDelimitedTableForAnalysis } from './tableService';
import { inspectEvidenceFile } from './evidenceFileService';
import { extractXlsx } from './xlsxService';
import { extractImageOcr } from './ocrService';
import { forensicSanitizeImport } from './securityService';
import type { EvidenceSourceAcquisition, SourcePage, SourceRecord, StructuredTableData, VisualEvidenceUnit } from '../types';

export interface ParsedEvidenceFile {
  name: string;
  size: number;
  text: string;
  pages?: SourcePage[];
  structuredTable?: StructuredTableData;
  structuredTables?: StructuredTableData[];
  acquisition?: EvidenceSourceAcquisition;
  visualUnits?: VisualEvidenceUnit[];
  kind?: 'pdf' | 'html' | 'csv' | 'tsv' | 'json' | 'xlsx' | 'image';
  parseMetadata?: {
    totalPages?: number;
    parsedTextPages?: number;
    rowCount?: number;
    renderedRowCount?: number;
    analyzedRowCount?: number;
    analysisComplete?: boolean;
    clippedCellCount?: number;
    cellCharacterCoverageRatio?: number;
    parseQuality?: PdfParseQuality;
    warnings: string[];
  };
}

const extractTextFromHtml = (html: string): string => {
  const cleanHtml = forensicSanitizeImport(html);
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleanHtml, 'text/html');
  doc.querySelectorAll('script, style').forEach(s => s.remove());
  return doc.body.textContent || "";
};

export const parseEvidenceFile = async (file: File): Promise<ParsedEvidenceFile> => {
  let text = "";
  let kind: ParsedEvidenceFile['kind'] = undefined;
  let parseMetadata: ParsedEvidenceFile['parseMetadata'] | undefined;
  let pages: SourcePage[] | undefined;
  let structuredTable: StructuredTableData | undefined;
  let structuredTables: StructuredTableData[] | undefined;
  let visualUnits: VisualEvidenceUnit[] | undefined;
  const lowerName = file.name.toLowerCase();
  let acquisition = await inspectEvidenceFile(file);
  if (acquisition.validation_status !== 'PASS') {
    throw new Error(`File ${file.name} failed deterministic type validation (${acquisition.validation_codes.join(', ')}).`);
  }

  if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const { text: pdfText, pages: extractedPages, visualUnits: extractedVisualUnits, metadata } = await extractPagesFromPdf(file, { sourceHash: acquisition.original_sha256 });
    text = pdfText;
    parseMetadata = {
      totalPages: metadata.totalPages,
      parsedTextPages: metadata.parsedTextPages,
      parseQuality: metadata.parseQuality,
      warnings: metadata.warnings
    };
    pages = extractedPages;
    visualUnits = extractedVisualUnits;
    kind = 'pdf';
  } else if (file.type === 'text/html' || lowerName.endsWith('.html')) {
    const rawHtml = await file.text();
    text = extractTextFromHtml(rawHtml);
    kind = 'html';
  } else if (file.type === 'text/csv' || lowerName.endsWith('.csv')) {
    const raw = await file.text();
    const rendered = renderDelimitedTableForAnalysis(raw, { fileName: file.name, delimiter: 'auto', sourceHash: acquisition.original_sha256 });
    text = rendered.text;
    kind = 'csv';
    parseMetadata = { rowCount: rendered.rowCount, renderedRowCount: rendered.renderedRowCount, analyzedRowCount: rendered.structuredTable.analysis_rows?.length || 0, analysisComplete: rendered.structuredTable.analysis_complete, clippedCellCount: rendered.clippedCellCount, cellCharacterCoverageRatio: rendered.cellCharacterCoverageRatio, warnings: rendered.warnings };
    structuredTable = rendered.structuredTable;
  } else if (file.type === 'text/tab-separated-values' || lowerName.endsWith('.tsv')) {
    const raw = await file.text();
    const rendered = renderDelimitedTableForAnalysis(raw, { fileName: file.name, delimiter: '\t', sourceHash: acquisition.original_sha256 });
    text = rendered.text;
    kind = 'tsv';
    parseMetadata = { rowCount: rendered.rowCount, renderedRowCount: rendered.renderedRowCount, analyzedRowCount: rendered.structuredTable.analysis_rows?.length || 0, analysisComplete: rendered.structuredTable.analysis_complete, clippedCellCount: rendered.clippedCellCount, cellCharacterCoverageRatio: rendered.cellCharacterCoverageRatio, warnings: rendered.warnings };
    structuredTable = rendered.structuredTable;
  } else if (lowerName.endsWith('.xlsx')) {
    const extracted = await extractXlsx(file, acquisition.original_sha256);
    text = extracted.text;
    kind = 'xlsx';
    parseMetadata = {
      rowCount: extracted.tables.reduce((sum, table) => sum + table.total_row_count, 0),
      renderedRowCount: extracted.tables.filter(table => table.model_eligible).reduce((sum, table) => sum + table.rows.length, 0),
      analyzedRowCount: extracted.tables.reduce((sum, table) => sum + (table.analysis_rows?.length || 0), 0),
      analysisComplete: extracted.tables.every(table => table.analysis_complete),
      clippedCellCount: 0,
      cellCharacterCoverageRatio: extracted.tables.some(table => table.truncated) ? undefined : 1,
      warnings: extracted.warnings
    };
    structuredTables = extracted.tables;
  } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(lowerName)) {
    const visualUnit = await extractImageOcr(file, acquisition.original_sha256);
    text = `Format: IMAGE_OCR\nOCR confidence: ${visualUnit.confidence}\nVisual interpretation: OCR text only; non-text visual semantics withheld.\n\n${visualUnit.text}`;
    kind = 'image';
    parseMetadata = {
      warnings: [
        'Local OCR extracted text only. Graph structure, spatial relationships, colors, shapes and other non-text visual semantics remain UNINSPECTED_VISUAL_REGION.',
        ...(visualUnit.confidence < 70 ? [`OCR confidence ${visualUnit.confidence.toFixed(1)} is observationally low; extracted text requires cautious interpretation.`] : [])
      ]
    };
    visualUnits = [visualUnit];
  } else if (file.type === 'application/json' || lowerName.endsWith('.json')) {
    const raw = await file.text();
    text = `Format: JSON\n\n${raw}`;
    kind = 'json';
  } else {
    throw new Error(`File ${file.name} is not a supported format (PDF, HTML, CSV, TSV, XLSX, PNG, JPEG, WEBP, JSON).`);
  }

  const extraction = kind === 'pdf'
    ? { extraction_method: 'browser_pdfjs' as const, extraction_version: 'pdfjs-dist@4' }
    : kind === 'html'
      ? { extraction_method: 'browser_dom' as const, extraction_version: 'dompurify@3' }
      : kind === 'csv' || kind === 'tsv'
        ? { extraction_method: 'browser_delimited' as const, extraction_version: 'delimited_parser_v3' }
        : kind === 'xlsx'
          ? { extraction_method: 'browser_xlsx_worker' as const, extraction_version: 'sheetjs-ce@0.20.3+zipjs@2.8.49' }
          : kind === 'image'
            ? { extraction_method: 'local_ocr' as const, extraction_version: 'tesseract.js@7.0.0' }
          : { extraction_method: 'browser_json' as const, extraction_version: 'json_parse_v1' };
  acquisition = { ...acquisition, ...extraction, extraction_status: 'PASS' };

  return { name: file.name, size: file.size, text, pages, structuredTable, structuredTables, acquisition, visualUnits, kind, parseMetadata };
};

export const toEvidenceSourceRecords = (files: readonly ParsedEvidenceFile[]): SourceRecord[] =>
  files.map((file, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    const sourceId = `src-${ordinal}`;
    return {
      schema_version: 'source_record_v1' as const,
      source_id: sourceId,
      source_name: `Document ${ordinal}`,
      kind: file.kind || 'text',
      acquisition: file.acquisition,
      visual_units: file.visualUnits?.map(unit => ({
        ...unit,
        source_id: sourceId
      })),
      parse_warnings: file.parseMetadata?.warnings || file.parseMetadata?.parseQuality?.warnings,
      extraction: file.kind === 'pdf' && file.parseMetadata
        ? {
            unit: 'page' as const,
            total_units: file.parseMetadata.totalPages || file.pages?.length || 0,
            processed_units: file.parseMetadata.parsedTextPages || file.pages?.length || 0,
            text_coverage_ratio: file.parseMetadata.parseQuality?.textCoverageRatio,
            sparse_units: file.parseMetadata.parseQuality?.sparseTextPages,
            truncated: (file.parseMetadata.parsedTextPages || 0) < (file.parseMetadata.totalPages || 0),
            quality: file.parseMetadata.parseQuality?.quality
          }
        : (file.kind === 'csv' || file.kind === 'tsv' || file.kind === 'xlsx') && file.parseMetadata
          ? {
              unit: 'row' as const,
              total_units: file.parseMetadata.rowCount || 0,
              processed_units: file.parseMetadata.analyzedRowCount || 0,
              text_coverage_ratio: file.parseMetadata.analysisComplete ? 1 : 0,
              truncated: !file.parseMetadata.analysisComplete
            }
          : { unit: 'document' as const, total_units: 1, processed_units: 1, truncated: false },
      structured_table: file.structuredTable,
      structured_tables: file.structuredTables,
      ...(file.kind === 'image' ? {} : file.pages?.length ? { pages: file.pages } : { text: file.text })
    };
  });
