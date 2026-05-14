
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
const DEFAULT_MAX_PAGES = 20;

export interface PdfExtractionResult {
  text: string;
  images: ImageInput[];
}

export const extractPagesFromPdf = async (
  file: File,
  opts?: { scale?: number; jpegQuality?: number; maxPages?: number }
): Promise<PdfExtractionResult> => {
  const scale = opts?.scale ?? DEFAULT_RENDER_SCALE;
  const jpegQuality = opts?.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts: string[] = [];
  const images: ImageInput[] = [];
  const pageCount = Math.min(pdf.numPages, maxPages);

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    pageTexts.push(text);

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

  if (pdf.numPages > maxPages) {
    console.warn(`[pdfService] ${file.name} has ${pdf.numPages} pages; rendered first ${maxPages} as images. Text was extracted for the first ${maxPages} pages only.`);
  }

  return { text: pageTexts.join('\n\n'), images };
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
