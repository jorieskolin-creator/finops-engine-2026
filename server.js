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
import { initializeInfrastructure } from './lib/infrastructure.js';
import { safeErrorCode } from './lib/safeErrors.js';
import { AttemptReconciler,ExecutionWorker,OutboxPublisher } from './lib/executionWorker.js';
import { CleanupWorker } from './lib/runLifecycleService.js';
import { resolveModelRouting } from './lib/modelRoutingPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const apiDir = path.join(__dirname, 'api');

let accepting=false;
let infrastructure;
try { resolveModelRouting(process.env); }
catch { console.error('[server] STARTUP_FAILED code=MODEL_ROUTING_CONFIGURATION_INVALID'); process.exit(1); }
try { infrastructure=await initializeInfrastructure(); }
catch(error) {
  const code=safeErrorCode(error);
  console.error(`[server] STARTUP_FAILED code=${code==='INTERNAL_ERROR'?'INFRASTRUCTURE_UNAVAILABLE':code}`);
  process.exit(1);
}
const app = express();
const publisher=new OutboxPublisher(infrastructure);const worker=new ExecutionWorker(infrastructure);const reconciler=new AttemptReconciler(infrastructure);const cleanup=new CleanupWorker(infrastructure);publisher.start();worker.start();reconciler.start();cleanup.start();
app.get('/livez',(_req,res)=>res.status(200).json({status:'live'}));
app.get('/readyz',async(_req,res)=>{if(!accepting)return res.status(503).json({status:'not_ready',code:'SHUTTING_DOWN'});try{await infrastructure.ready();return res.status(200).json({status:'ready'});}catch{return res.status(503).json({status:'not_ready',code:'DEPENDENCY_UNAVAILABLE'});}});

// Text-only stage approval intake. Images and base64 payloads are prohibited.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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
      console.error(`[server] REQUEST_FAILED route=${route} code=${safeErrorCode(err)}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'INTERNAL_ERROR' });
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
const server=app.listen(port, () => {
  accepting=true;
  console.log(`[server] Listening on :${port}`);
});
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;accepting=false;server.close(async()=>{await Promise.all([publisher.stop(),worker.stop(),reconciler.stop(),cleanup.stop()]);await infrastructure.close();process.exit(0);});setTimeout(()=>process.exit(1),30_000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
