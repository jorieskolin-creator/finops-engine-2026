// Railway/long-lived-Node entrypoint. Mounts the existing Vercel-style
// `(req, res) => {}` handlers in api/ as Express routes, serves the built
// SPA from dist/, and falls back to index.html for client-side routes.
//
// The api/*.js files keep working unchanged on Vercel because they still
// `export default handler` — this file is just a parallel host for Railway.

import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const apiDir = path.join(__dirname, 'api');

const app = express();

// Body limit must accommodate base64-encoded PDF pages sent to /api/generate.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Mount each api/*.js file at /api/<basename>. Dynamic import keeps the
// Vercel handler signature intact — Express's (req, res) is compatible.
const apiFiles = fs
  .readdirSync(apiDir)
  .filter((f) => f.endsWith('.js'));

for (const file of apiFiles) {
  const route = `/api/${path.basename(file, '.js')}`;
  const mod = await import(pathToFileURL(path.join(apiDir, file)).href);
  const handler = mod.default;
  if (typeof handler !== 'function') {
    console.warn(`[server] Skipping ${file} — no default export`);
    continue;
  }
  app.all(route, async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[server] Unhandled error in ${route}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error' });
      }
    }
  });
  console.log(`[server] Mounted ${route} -> api/${file}`);
}

// Static SPA. `index: false` so the SPA fallback below decides which HTML
// to serve (otherwise express.static would short-circuit "/").
app.use(express.static(distDir, { index: false }));

app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[server] Listening on :${port}`);
});
