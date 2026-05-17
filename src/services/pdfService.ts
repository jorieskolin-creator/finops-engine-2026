
import * as pdfjsLib from 'pdfjs-dist';
import { ImageInput } from '../types';

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

const DEFAULT_RENDER_SCALE = 1.6;
const DEFAULT_JPEG_QUALITY = 0.78;
const DEFAULT_MAX_TEXT_PAGES = 100;
const DEFAULT_MAX_IMAGE_PAGES = 100;
const DEFAULT_MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MIN_VISUAL_CONTEXT_PAGES = 5;
const SPARSE_TEXT_CHAR_THRESHOLD = 250;

export interface PdfExtractionResult {
  text: string;
  images: ImageInput[];
  metadata: {
    totalPages: number;
    parsedTextPages: number;
    renderedImagePages: number;
    warnings: string[];
  };
}

export const extractPagesFromPdf = async (
  file: File,
  opts?: { scale?: number; jpegQuality?: number; maxTextPages?: number; maxImagePages?: number; maxImageBytes?: number }
): Promise<PdfExtractionResult> => {
  const scale = opts?.scale ?? DEFAULT_RENDER_SCALE;
  const jpegQuality = opts?.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const maxTextPages = opts?.maxTextPages ?? DEFAULT_MAX_TEXT_PAGES;
  const maxImagePages = opts?.maxImagePages ?? DEFAULT_MAX_IMAGE_PAGES;
  const maxImageBytes = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts: string[] = [];
  const images: ImageInput[] = [];
  const warnings: string[] = [];
  const pageCount = Math.min(pdf.numPages, maxTextPages);
  let encodedImageBytes = 0;
  let imageBudgetWarningAdded = false;

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    pageTexts.push(`[PDF_PAGE source="${file.name}" page="${i}"]\n${text}\n[/PDF_PAGE]`);

    const shouldRenderImage =
      images.length < MIN_VISUAL_CONTEXT_PAGES ||
      text.trim().length < SPARSE_TEXT_CHAR_THRESHOLD;

    if (!shouldRenderImage || images.length >= maxImagePages || encodedImageBytes >= maxImageBytes) {
      continue;
    }

    try {
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
      const base64 = dataUrl.split(',')[1];
      if (base64 && base64.length > 0) {
        const nextEncodedImageBytes = encodedImageBytes + base64.length;
        if (nextEncodedImageBytes > maxImageBytes) {
          if (!imageBudgetWarningAdded) {
            warnings.push(`Visual page extraction stopped after ${images.length} page image(s) because the encoded image budget was reached.`);
            imageBudgetWarningAdded = true;
          }
          continue;
        }
        encodedImageBytes = nextEncodedImageBytes;
        images.push({
          mimeType: 'image/jpeg',
          data: base64,
          source_name: file.name,
          page_number: i
        });
      }
    } catch (e) {
      console.warn(`[pdfService] Page ${i} of ${file.name} failed to rasterize:`, e);
    }
  }

  if (pdf.numPages > maxTextPages) {
    const warning = `${file.name} has ${pdf.numPages} pages; text extraction was capped at the first ${maxTextPages} pages.`;
    warnings.push(warning);
    console.warn(`[pdfService] ${warning}`);
  }

  if (images.length < pageCount) {
    warnings.push(`Text was extracted for ${pageCount} page(s); ${images.length} page image(s) were included selectively for visual/OCR evidence.`);
  }

  return {
    text: pageTexts.join('\n\n'),
    images,
    metadata: {
      totalPages: pdf.numPages,
      parsedTextPages: pageCount,
      renderedImagePages: images.length,
      warnings
    }
  };
};

export const imageFileToInput = async (file: File): Promise<ImageInput> => {
  if (!file.type.startsWith('image/')) {
    throw new Error(`File ${file.name} is not an image (mime: ${file.type}).`);
  }
  const allowed: ImageInput['mimeType'][] = ['image/png', 'image/jpeg', 'image/webp'];
  const mimeType = (allowed.includes(file.type as any) ? file.type : 'image/jpeg') as ImageInput['mimeType'];

  const arrayBuffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const base64 = btoa(binary);

  return {
    mimeType,
    data: base64,
    source_name: file.name
  };
};
