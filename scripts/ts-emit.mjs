import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '../node_modules/typescript/lib/typescript.js';

const exists = async (url) => {
  try {
    await readFile(new URL(url));
    return true;
  } catch {
    return false;
  }
};

const resolveImport = async (spec, fromUrl) => {
  if (!spec.startsWith('.')) return null;
  const base = new URL(spec, fromUrl).href;
  const candidates = spec.endsWith('.json') || spec.endsWith('.ts')
    ? [base]
    : [base + '.ts', base + '.json', base.replace(/\/?$/, '/index.ts')];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve ${spec} from ${fromUrl}`);
};

export const emitTypescript = async (entry, outDir) => {
  await mkdir(outDir, { recursive: true });
  const compiled = new Map();
  let seq = 0;
  const compile = async (url) => {
    if (compiled.has(url)) return compiled.get(url);
    const dest = join(outDir, `m${seq++}.mjs`);
    compiled.set(url, dest);
    if (url.endsWith('.json')) {
      const json = await readFile(new URL(url), 'utf8');
      await writeFile(dest, `export default ${json};\n`);
      return dest;
    }
    const source = await readFile(new URL(url), 'utf8');
    const specs = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(match => match[1]);
    let rewritten = source;
    for (const spec of specs) {
      const resolved = await resolveImport(spec, url);
      const child = await compile(resolved);
      rewritten = rewritten.replaceAll(`'${spec}'`, JSON.stringify(pathToFileURL(child).href)).replaceAll(`"${spec}"`, JSON.stringify(pathToFileURL(child).href));
    }
    const output = ts.transpileModule(rewritten, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2020,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      },
      fileName: url,
    }).outputText;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, output);
    return dest;
  };
  return compile(pathToFileURL(entry).href);
};
