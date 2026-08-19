# FinOps Engine

Evidence-gated FinOps Maturity Assessment prototype. The React, TypeScript, and Vite client parses source documents in the browser and orchestrates a multi-stage assessment through authenticated OpenAI, Anthropic, and xAI proxy endpoints under `api/`.

The repository is currently intended for solution development, structural validation, and accuracy/reproducibility testing. It is not yet a production-ready multi-user service.

## Local development

Install the locked dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env.local
```

Set `SECRET_KEY`, `OPENAI_API_KEY` (or `GPT_API_KEY`), `ANTHROPIC_API_KEY`, and `XAI_API_KEY`. Provider keys remain server-side and are never included in the Vite client bundle.

For the simplest full-stack development environment, use Vercel's local runtime, which loads `.env.local` and serves Vite together with the API handlers:

```bash
npx --yes vercel dev
```

For UI-only work, run `npm run dev`. The UI will load, but assessments cannot complete unless `/api/*` is also available. To use the repository's Node adapter instead, export the required environment variables, run `npm run build && npm start` on port 3000, and run `npm run dev` separately for Vite and its `/api` proxy.

## Active model architecture

Model profiles, AI-role assignments, and fallback chains are centralized in the server-owned `lib/modelRoutingPolicy.js`. The active providers are OpenAI, Anthropic, and xAI. Every existing model stage maps to exactly one of `REASONER`, `WORKHORSE`, or `QUALITY_CHECKER`; roles select their configured primary and fallback without changing pipeline stages. The browser obtains the effective content-free route from `/api/model-routing`, while governed-packet approval independently enforces the same Railway policy.

| Task/role | Configured primary → fallback |
|-----------|-------------------------------|
| Acquisition and DLP | Deterministic local processing; no model call |
| `REASONER` | OpenAI GPT-5.6 Sol → xAI Grok 4.6 |
| `WORKHORSE` | Anthropic Claude Sonnet 5 → xAI Grok 4.6 |
| `QUALITY_CHECKER` | xAI Grok 4.6 → Anthropic Claude Sonnet 5 |
| Deterministic Quality Gate | Authoritative code path; no model decision |

All twelve role-routing variables are required as one complete policy. The configured model must match a code-authorized model for its provider; OpenAI `gpt-5.6-sol` and `gpt-5.6-terra` are authorized for every role. Partial policies, legacy provider-level variables, unknown providers, unsupported models, and identical primary/fallback profiles fail closed. Provider fallback is allowed only for the existing explicit safe-failure outcomes; post-send uncertainty never becomes fallback.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SECRET_KEY` | Yes | Shared assessment password and HMAC key for session cookies. Use at least 32 random characters. Rotation invalidates active sessions. |
| `OPENAI_API_KEY` or `GPT_API_KEY` | Yes for OpenAI stages | Server-side OpenAI credential. `GPT_API_KEY` takes precedence when both are set. |
| `ANTHROPIC_API_KEY` | Yes for Anthropic stages | Server-side Anthropic credential. |
| `XAI_API_KEY` | Yes | Server-side xAI credential used by the governed Grok adapter. |
| `REASONER_*` | Yes | Primary and fallback provider/model for difficult semantic adjudication and complex sequencing. |
| `WORKHORSE_*` | Yes | Primary and fallback provider/model for normal bounded production analysis. |
| `QUALITY_CHECKER_*` | Yes | Primary and fallback provider/model for independent semantic verification. |
| `DATABASE_URL` | Yes for the Node server | PostgreSQL control-plane connection. Startup fails closed if unavailable or unmigrated. |
| `REDIS_URL` | Yes for the Node server | Redis execution-plane connection. Startup fails closed if unavailable. |
| `VITE_FINOPS_TACTICS_URL` | No | Public remote tactics database URL exposed to the browser. |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob credential used by `/api/kb-index` for the remote PDF knowledge base. |
| `FINOPS_KB_BLOB_PREFIX` | No | Blob path prefix; defaults to `Knowledge Base/`. |
| `PORT` | No | Node server port; defaults to 3000. Hosting platforms normally provide it. |

Do not commit populated `.env` or `.env.local` files.

## Access control and API surface

The UI is public, but assessment and supporting API operations require an HMAC-signed `fe_session` cookie. Authentication currently uses one shared password; model/stage/token allowlists and per-user authorization are not yet enforced server-side.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/login` | POST | Verify the shared password and issue an eight-hour HttpOnly, Secure, SameSite=Lax session cookie. |
| `/api/logout` | POST | Clear the session cookie. |
| `/api/session` | GET | Check the current session. |
| `/api/model-routing` | GET | Return the authenticated, content-free effective model route. |
| `/api/governed-packet` | POST | Authenticated approval of versioned, sanitized text-only stage packets. |
| `/api/openai-generate` | POST | Packet-ID-only governed OpenAI dispatch. |
| `/api/anthropic-generate` | POST | Packet-ID-only governed Anthropic dispatch. |
| `/api/xai-generate` | POST | Packet-ID-only governed xAI dispatch. |

Milestone C uses structured source/page records and blocks image processing until local OCR/redaction is available. Approval is deterministic pattern-based risk reduction, not proof that arbitrary source content is public. PostgreSQL stores canonical governed packet bytes for dispatch plus content-free control metadata. Redis holds coordination state, checkpoints, and governed results. Packet bodies and Redis transient content are deleted after acknowledged delivery, terminal failure/deletion, or expiry and never survive the immutable 24-hour run deadline.
| `/api/model-result` | POST | Recover a completed governed result from Redis. |
| `/api/run` | GET/POST/DELETE | Create, inspect, complete, fail, or delete an authoritative run. |
| `/api/kb-index` | GET | Build or return the cached remote reference-KB index. |
| `/api/log` | POST | Write authenticated client pipeline events to server logs. |

The authentication implementation lives in `lib/auth.js`. The current shared-password design is suitable only for a controlled prototype audience.

## Data handling and privacy boundaries

The current implementation provides the following controls and limitations:

- Source files are parsed in the browser; the original files are not uploaded as files by this application.
- Only browser-extracted text is sent through the server proxies to the configured OpenAI, Anthropic, and xAI services. Direct images are rejected, PDF pages are not rasterized, and scanned/visual-only pages are not processed because local OCR is unavailable. Provider-side storage and retention depend on the configured provider account and contract terms.
- A deterministic pattern scan blocks recognized high-risk secret and contextual financial-value patterns before the main assessment. A model-assisted review checks distributed text samples. This is policy approval and risk reduction, not proof of public classification or comprehensive PII/data-classification prevention; source material must be reviewed before upload.
- The completed report, including report-visible evidence, is stored in browser `sessionStorage` for crash recovery until the tab/session data is cleared.
- Canonical governed packet bodies are retained temporarily as PostgreSQL `BYTEA`; governed model output may remain in Redis for up to 30 minutes for recovery. Completion, failure, expiry, and user deletion synchronously tombstone Redis coordination state and delete PostgreSQL packet bodies; retryable cleanup is resumed by the worker. Content-free operational metadata expires after 90 days.
- RunTrace excludes raw source documents, full prompts, and API keys, but it includes hashes, source references, and report-visible quote snippets.
- Generated report text is privacy-scrubbed for known token, contact, and selected name patterns before display. Automated redaction is not a substitute for human review before sharing.

Do not describe the current system as zero-retention. Deployment-platform logs, model-provider policies, browser session storage, and transient response recovery are separate retention boundaries.

## Deployment status

The final hosting and authorization model is still an open design decision. The checked-in configurations support experimentation on Vercel and Railway, but they are not behaviorally identical.

### Railway / long-lived Node process

`railway.json` builds the Vite application, runs `npm run migrate` once as a pre-deploy command, and starts `server.js`. The server requires migrated PostgreSQL and Redis, exposes `/livez` and dependency-aware `/readyz`, and drains HTTP before closing infrastructure pools on SIGTERM/SIGINT.

Milestone C uses PostgreSQL as the authoritative store for canonical packet bytes, runs, packet metadata, attempts, an opaque leased dispatch outbox, and cleanup evidence. Redis holds deadline-capped coordination keys, send-authorization fences, checkpoints, and governed results, but no packet bodies. A long-lived worker reloads ledger state and canonical bytes for every stream message. Provider invocation is at-most-once after the Redis `SEND_AUTHORIZED` boundary: crashes or transport uncertainty after that boundary become `outcome_unknown` and are never automatically retried or used for fallback. This is an explicit ambiguity state, not a claim of exactly-once invocation.

The browser creates an authoritative server-UUID run before governed packet or model processing and awaits verified transient cleanup before returning a completed report. Active runs expire after two hours without authoritative activity and always within an immutable 24-hour deadline. Deletion invalidates execution immediately; `deleted` is recorded only after verified cleanup. Cleanup evidence contains fixed codes, counts, and timestamps—never content. This does not claim deletion from platform or database backups. Generated HTML remains browser-controlled and is not stored by the backend.

Railway is the supported governed-dispatch target. PostgreSQL claims use fencing and Redis atomically records `SEND_AUTHORIZED`; this is not exactly-once delivery. A crash after authorization is intentionally `outcome_unknown`, with late governed-result recovery but no automatic provider retry/fallback.

### Vercel

Vercel governed dispatch remains explicitly unsupported. Its independent API functions do not initialize the Railway worker lifecycle, so `/api/run` and governed packet/model routes fail closed rather than bypassing PostgreSQL, Redis, or the dispatch ledger. Vercel may still serve UI/prototype work that does not execute governed assessments.

## Build and focused tests

```bash
npm run build
npm run test:evidence-check
npm run test:model-routing
npm run test:privacy
```

`npm test` discovers and runs all focused `test:*` scripts, including the injected-adapter control-plane tests.

## Scenario and boundary fixtures

The synthetic fixtures under `test/` represent separate organizations and must be assessed separately. They are engineering inputs for exercising parsing, routing, evidence, privacy, and Quality Gate boundaries. They are not expert-approved reference assessments and must not be used to claim model accuracy, reproducibility, or drift monitoring.

The low-, borderline-, and strong-evidence scenarios provide broad pipeline inputs. Tier 1 fixtures exercise narrower document types such as governance policies, tagging standards, operating-model charters, strategies, and optimization reviews.

## Acquisition quality telemetry

Completed assessments include a versioned `acquisition_quality_snapshot_v1` under `meta.acquisition_quality`. The Master Data HTML renders the same snapshot visibly and preserves it in the embedded `finops-data` JSON.

The metrics intentionally remain separate:

- **Extraction completeness** combines processed source units with PDF text coverage; capped or sparse extraction is reported explicitly.
- **Evidence coverage** is the share of the maturity and anti-pattern assessment surface with evidence or an explicit tested-absence result. The existing `metrics.evidence_density` value remains unchanged for scoring compatibility and is exposed here as the legacy overall coverage value; provenance integrity separately reports whether covered criteria resolve to registered sources.
- **Evidence density** is a new observability measure within covered objects: 60% verified evidence strength, 20% per-object source diversity, and 20% evidence-category diversity.
- **Provenance integrity** reports source-backed versus unresolved covered criteria without storing source content in the snapshot.
- **KB completeness and readiness** report expected document coverage, delivery defects, and stage-packet readiness separately from customer evidence quality.

Milestone 3 readiness is `observability_only`: it does not alter prompts, Phase 2 scores, assessment classification, or Quality Gate decisions. Hard acquisition enforcement is deferred until the packet contracts and operational thresholds are separately approved.

The first structured-data vertical slice analyzes bounded CSV/TSV tables for A1/AP-A1 ownership, tagging, and allocation signals. It emits versioned `derived_analytical_evidence_v1` records in shadow mode under RunTrace. These records contain only percentages, counts, controlled statuses, source IDs, and analyzer provenance—not source cell values—and do not yet affect prompts, scoring, or Quality Gate decisions.

Bounded retrieval diagnostics simulate at most two deterministic re-read passes for weak domain packets. Each pass records coverage before/after, gain, candidate count, selected chunk IDs, strategy, and a controlled stop reason. This remains shadow-only: selected diagnostic candidates are not inserted into current prompts or assessment decisions.

The scenario and boundary suite uses synthetic engineering inputs to exercise deterministic BLOCK/WARN/GO thresholds, all seven evidence categories, anti-pattern absence semantics, DLP block/caution behavior, malformed delimited tables, and source-schema faults. These scenarios are regression controls only; they are not expert-approved reference assessments and do not measure accuracy or drift.

Milestone 6 scale readiness is explicit rather than inferred. Knowledge Packet contracts are checked across all A–F domains, stages, and 60 stream-qualified objects. Data Signal Registry coverage reports A1/AP-A1 as shadow-analyzer-enabled and marks the remaining objects `NO_AUTHORITATIVE_ANALYZER_SEMANTICS` until governed definitions are supplied by the KB Maintainer; no placeholder analyzers or thresholds are invented.
