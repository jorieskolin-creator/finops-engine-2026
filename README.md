# FinOps Engine

Evidence-gated FinOps Maturity Assessment prototype. The React, TypeScript, and Vite client parses source documents in the browser and orchestrates a multi-stage assessment through authenticated OpenAI and Anthropic proxy endpoints under `api/`.

The repository is currently intended for solution development, structural validation, and accuracy/reproducibility testing. It is not yet a production-ready multi-user service.

## Local development

Install the locked dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env.local
```

Set `SECRET_KEY`, `OPENAI_API_KEY` (or `GPT_API_KEY`), and `ANTHROPIC_API_KEY`. Provider keys remain server-side and are never included in the Vite client bundle.

For the simplest full-stack development environment, use Vercel's local runtime, which loads `.env.local` and serves Vite together with the API handlers:

```bash
npx --yes vercel dev
```

For UI-only work, run `npm run dev`. The UI will load, but assessments cannot complete unless `/api/*` is also available. To use the repository's Node adapter instead, export the required environment variables, run `npm run build && npm start` on port 3000, and run `npm run dev` separately for Vite and its `/api` proxy.

## Active model architecture

Model profiles, stage assignments, and fallback chains are centralized in `src/models.ts`. The active providers are OpenAI and Anthropic; Gemini is not part of the current runtime.

| Stage group | Normal primary provider/profile |
|-------------|---------------------------------|
| Preflight / DLP | OpenAI GPT-5.5, low reasoning |
| Forensic audit | Anthropic Claude Sonnet 4.6 |
| Targeted rescan | Anthropic Claude Opus 4.7 |
| Evidence check and adjudication | OpenAI GPT-5.5 |
| Evidence synthesis | Anthropic Claude Sonnet 4.6 |
| Roadmap synthesis | Anthropic Claude Opus 4.7 |
| Fact check and quality-gate explanation | OpenAI GPT-5.5 |

Every stage has an ordered fallback chain. Treat `src/models.ts`, rather than this summary, as the source of truth when changing model routing. The optional `cheap_test` mode is a development cost-control mode, not an authorization boundary.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SECRET_KEY` | Yes | Shared assessment password and HMAC key for session cookies. Use at least 32 random characters. Rotation invalidates active sessions. |
| `OPENAI_API_KEY` or `GPT_API_KEY` | Yes for OpenAI stages | Server-side OpenAI credential. `GPT_API_KEY` takes precedence when both are set. |
| `ANTHROPIC_API_KEY` | Yes for Anthropic stages | Server-side Anthropic credential. |
| `VITE_FINOPS_TACTICS_URL` | No | Public remote tactics database URL exposed to the browser. |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob credential used by `/api/kb-index` for the remote PDF knowledge base. |
| `FINOPS_KB_BLOB_PREFIX` | No | Blob path prefix; defaults to `Knowledge Base/`. |
| `VITE_FINOPS_MODEL_MODE` | No | Set to `cheap_test` only for development runs. |
| `PORT` | No | Node server port; defaults to 3000. Hosting platforms normally provide it. |

Do not commit populated `.env` or `.env.local` files.

## Access control and API surface

The UI is public, but assessment and supporting API operations require an HMAC-signed `fe_session` cookie. Authentication currently uses one shared password; model/stage/token allowlists and per-user authorization are not yet enforced server-side.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/login` | POST | Verify the shared password and issue an eight-hour HttpOnly, Secure, SameSite=Lax session cookie. |
| `/api/logout` | POST | Clear the session cookie. |
| `/api/session` | GET | Check the current session. |
| `/api/openai-generate` | POST | Authenticated OpenAI Responses API proxy. |
| `/api/anthropic-generate` | POST | Authenticated Anthropic Messages API proxy. |
| `/api/model-result` | POST | Recover a completed model response from transient process memory. |
| `/api/kb-index` | GET | Build or return the cached remote reference-KB index. |
| `/api/log` | POST | Write authenticated client pipeline events to server logs. |

The authentication implementation lives in `lib/auth.js`. The current shared-password design is suitable only for a controlled prototype audience.

## Data handling and privacy boundaries

The current implementation provides the following controls and limitations:

- Source files are parsed in the browser; the original files are not uploaded as files by this application.
- Parsed source text and base64-encoded source images are sent through the server proxies to the configured OpenAI and Anthropic services. Provider-side storage and retention depend on the configured provider account and contract terms.
- A deterministic text scan blocks recognized high-risk secret patterns before the main assessment. A model-assisted review checks distributed text samples and a bounded set of images. This is risk reduction, not comprehensive PII, image-secret, or data-classification prevention; source material must be reviewed before upload.
- The completed report, including report-visible evidence, is stored in browser `sessionStorage` for crash recovery until the tab/session data is cleared.
- Model output may be retained in process memory for up to 15 minutes to recover interrupted response streams. No durable server-side assessment database is implemented.
- RunTrace excludes raw source documents, full prompts, and API keys, but it includes hashes, source references, and report-visible quote snippets.
- Generated report text is privacy-scrubbed for known token, contact, and selected name patterns before display. Automated redaction is not a substitute for human review before sharing.

Do not describe the current system as zero-retention. Deployment-platform logs, model-provider policies, browser session storage, and transient response recovery are separate retention boundaries.

## Deployment status

The final hosting and authorization model is still an open design decision. The checked-in configurations support experimentation on Vercel and Railway, but they are not behaviorally identical.

### Railway / long-lived Node process

`railway.json` builds the Vite application and starts `server.js`. The Node adapter dynamically mounts `api/*.js`, accepts larger JSON bodies for base64 image payloads, serves `dist/`, and provides process-local model-result recovery.

Current limitation: recovery state and the remote-KB cache are in memory. They are not shared across multiple processes or replicas and disappear on restart.

### Vercel

`vercel.json` builds the Vite client and registers `api/*.js` as functions. Normal streamed responses can work, but two limitations matter:

1. `/api/model-result` uses module-local memory, which is not a reliable shared store across separate function invocations or instances.
2. The application-level upload allowance can produce inline JSON/image requests larger than serverless request-body limits.

Until shared result storage and reference-based image transport are implemented, Vercel should be treated as a constrained prototype target rather than equivalent to the long-lived Node deployment.

## Build and focused tests

```bash
npm run build
npm run test:evidence-check
npm run test:model-routing
npm run test:privacy
```

The repository currently exposes focused `test:*` scripts rather than one aggregate `npm test` command.

## Drift and golden fixtures

The synthetic fixtures under `test/` represent separate organizations and must be assessed separately. The per-pack drift suite is the meaningful comparison against `src/knowledge_base/golden_baselines.json`.

The older combined Drift Test runs Crawl, Walk, and Run fixtures as one document set. Treat that only as a pipeline simulation, not as a valid maturity or model-drift result.

Run the per-pack suite:

- after model-routing or prompt changes;
- before a release candidate;
- after scoring, taxonomy, or evidence-gate changes;
- periodically to monitor provider-model behavior.

Do not modify calibrated golden fixtures without reviewing and versioning their expected baselines.
