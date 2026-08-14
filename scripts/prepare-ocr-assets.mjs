import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'ocr-assets');
const dependency = (...parts) => path.join(root, 'node_modules', ...parts);

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'core'), { recursive: true });
await mkdir(path.join(output, 'lang'), { recursive: true });

await cp(dependency('tesseract.js', 'dist', 'worker.min.js'), path.join(output, 'worker.min.js'));
for (const name of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js'
]) {
  await cp(dependency('tesseract.js-core', name), path.join(output, 'core', name));
}
await cp(
  dependency('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  path.join(output, 'lang', 'eng.traineddata.gz')
);
await cp(
  dependency('@tesseract.js-data', 'fin', '4.0.0_best_int', 'fin.traineddata.gz'),
  path.join(output, 'lang', 'fin.traineddata.gz')
);

console.log('Prepared same-origin OCR worker, core, and English/Finnish language assets.');
