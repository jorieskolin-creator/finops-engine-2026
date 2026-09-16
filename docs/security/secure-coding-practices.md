# Secure coding practices — FinOps Engine

Status: Evaluated from the current codebase. This is a working summary for reviews, onboarding, and change control. It is not a claim that the Engine is a production multi-user service.

Audience: engineers changing auth, API, governance, privacy, logging, or dispatch code; reviewers checking that a change stays inside the existing security contract.

Related sources: `README.md` (access control and data-handling boundaries), `docs/architecture/ADR-001-execution-and-evidence-lineage.md` (dispatch lineage and fail-closed packet binding), `lib/auth.js`, `lib/governance.js`, `src/services/deterministicPrivacyService.ts`.

## How to use this summary

1. Treat the practices below as the current contract. A change that weakens one of them needs an explicit design decision, not a silent exception.
2. Prefer the listed implementation files over older narrative decks when descriptions disagree.
3. Use the checklist at the end when reviewing PRs that touch secrets, packets, prompts, reports, logs, or SQL.
4. Do not describe the Engine as zero-retention, fully classified, or multi-tenant authorized. Those claims are out of scope for the current prototype.

## Evaluation snapshot

The Engine already practices **defense in depth around LLM egress**, not a generic web-app hardening kit. The strongest controls sit on:

- keeping provider keys and model dispatch on the server
- screening and hashing governed packets before any external send
- redacting or blocking sensitive source material before packet assembly
- returning content-free error codes and logs
- failing closed when routing, infrastructure, or packet binding is uncertain

The current shared-password session, lack of per-user authorization, and missing browser/HTTP hardening headers are documented prototype limits, not completed production controls.

## Design principles in use

| Principle | How it shows up |
|-----------|-----------------|
| Fail closed | Invalid model routing, missing PostgreSQL/Redis, packet-binding mismatch, unknown schemas, and unsupported Vercel governed dispatch reject the request instead of choosing a weaker path. |
| Least data in motion | Source files stay in the browser. Only extracted, privacy-screened text reaches provider APIs. Images are not sent as model inputs. |
| Server-owned secrets | Provider keys and `SECRET_KEY` never enter the Vite client bundle. |
| Exact allowlists | JSON bodies, log metadata, packet keys, model settings, and output contracts reject unknown fields. |
| Content-free operations | Logs, cleanup evidence, and many API errors carry codes, hashes, counts, and IDs — not source text, prompts, or keys. |
| Canonical identity | Governed packets are hashed over canonical bytes; dispatch re-binds packet ID, hash, run, provider, model, and stage before send. |

## 1. Secrets and configuration

- Environment files `.env`, `.env.local`, and `.env.*.local` are gitignored. `.env.example` is empty placeholders only.
- `SECRET_KEY`, `OPENAI_API_KEY` / `GPT_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DATABASE_URL`, and `REDIS_URL` are server-side. Vite exposes only `VITE_FINOPS_TACTICS_URL`.
- `lib/modelRoutingPolicy.js` requires a complete twelve-field role policy. Partial policies, unknown providers/models, identical primary/fallback profiles, missing provider credentials, and legacy `PRIMARY_MODEL_PROVIDER` / `FALLBACK_MODEL_PROVIDER` fail startup.
- Railway `server.js` also fails startup when infrastructure or routing is unavailable. Vercel governed dispatch fails closed with `VERCEL_GOVERNED_DISPATCH_UNSUPPORTED` rather than bypassing PostgreSQL, Redis, or the ledger.

Implementation: `.gitignore`, `.env.example`, `vite.config.ts`, `lib/modelRoutingPolicy.js`, `server.js`, `api/governed-packet.js`, `api/run.js`.

## 2. Authentication and session handling

- Assessment APIs require an HMAC-SHA256 signed `fe_session` cookie. The UI is public; `/api/login`, `/api/logout`, and `/api/session` are the auth surface.
- Password compare and cookie signature verify use `crypto.timingSafeEqual` after equal-length checks.
- Session cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, eight-hour `Max-Age`. Client JS cannot read the cookie (`src/services/authService.ts` only tracks a boolean from `/api/session`).
- Cookie payload is `{ exp, role }` with server-side expiry check. Rotating `SECRET_KEY` invalidates all sessions.

**Prototype limit:** `SECRET_KEY` is both the shared login password and the HMAC key. There is one shared password, no per-user identity, and no server-side model/stage/token allowlist beyond the routing policy. That design is suitable only for a controlled audience.

Implementation: `lib/auth.js`, `api/login.js`, `api/logout.js`, `api/session.js`, and `requireSession()` on `/api/run`, `/api/governed-packet`, `/api/openai-generate`, `/api/anthropic-generate`, `/api/xai-generate`, `/api/model-result`, `/api/model-routing`, `/api/checkpoint`, `/api/kb-index`, and `/api/log`.

## 3. Input validation and request shape

- Express JSON and urlencoded bodies are capped at `2mb`. Server comments state text-only intake; images and base64 payloads are prohibited.
- Governed packet approval (`lib/governance.js`) enforces exact keys, versioned schema/policy IDs, identifier regexes, a single `type: text` part, destination `provider:external_model`, authorized model settings, and an authorized output contract.
- Provider dispatch (`lib/providerGateway.js`) accepts only packet IDs and binding fields. The browser cannot supply prompt text at send time. Unknown JSON keys fail as `INVALID_DISPATCH_PACKET`. Internal pipeline calls must set `internal_pipeline_call: true`.
- `/api/run` validates UUID run IDs, exact quality-snapshot keys/ranges, and exact shadow-telemetry keys/invariants.
- `/api/log` accepts only known events and per-event metadata allowlists (`lib/operationalLogPolicy.js`). Strings over 160 characters, newlines, `data:`, and `base64` are dropped.
- Source records, pages, structured tables, and visual OCR units fail closed on unknown schemas, competing payloads, duplicate pages, hidden sheets marked model-eligible, or incomplete OCR/redaction status.

Implementation: `server.js`, `lib/governance.js`, `lib/providerGateway.js`, `api/run.js`, `api/log.js`, `src/services/sourceRegistryService.ts`.

## 4. Injection, XSS, and untrusted content

- PostgreSQL access uses parameterized queries (`$1`, `$2`, …) in `lib/controlPlaneRepository.js`. SQL is not concatenated from user text.
- HTML imports are sanitized with DOMPurify before text extraction (`src/services/securityService.ts`, `forensicSanitizeImport` in `src/App.tsx`). Script/style/iframe/object/embed/form tags and inline event handlers are forbidden.
- Report markdown is HTML-escaped before bold/italic tags are added (`src/services/reportTextService.ts`). SVG gauge/radar labels use `escapeXml`.
- Source chunks rendered into model packets escape XML so `</CHUNK>`-style sentinels in customer text cannot break packet markup.
- Raw filenames are not placed in model-visible manifests; privacy replacement uses pseudonymous `Document NNN` names.
- Prompt construction isolates customer material in `<UNTRUSTED_CONTENT>` and instructs the model to use only that text (`src/prompts.ts`, `src/knowledge_base/finops_guardrails.md`).
- Summary and Master Data HTML must not embed `finops-data`, other hidden JSON, or script payloads. Restore a saved assessment from the explicit JSON download. Older HTML files that still contain `finops-data` can be imported; `<` in that legacy payload is escaped to `\u003c` to avoid script breakout (`src/services/reportImportService.ts`).

Implementation: `lib/controlPlaneRepository.js`, `src/services/securityService.ts`, `src/services/reportTextService.ts`, `src/services/svgChartService.ts`, `src/services/sourceRegistryService.ts`, `src/services/deterministicPrivacyService.ts`, `src/prompts.ts`.

## 5. Data protection, DLP, and privacy

Layered controls run **before** the first generative call:

1. **Browser acquisition.** Files are parsed locally. Direct images are not sent to providers. Sparse/visual PDF pages use local OCR; graph structure and other non-text visuals are withheld as `UNINSPECTED_VISUAL_REGION`. Hidden spreadsheet sheets are not model-eligible.
2. **Deterministic privacy gate.** `sanitizeEvidenceSources()` blocks private keys, cloud keys, API keys, credential assignments, and bearer tokens; it redacts government IDs, personal financial IDs, home addresses, contextual person names, emails, phones, IPs, billing/invoice IDs, and selected financial-value phrases (`src/services/deterministicPrivacyService.ts`).
3. **Registry DLP scan.** `scanRegistryDlp()` blocks remaining high-risk secret/cloud-key/private-key patterns and warns on contact and financial-caution hits (`src/services/sourceRegistryService.ts`).
4. **Governed packet screen.** Approval rejects image/base64 payloads, secret material, residual personal/financial classification, split identifiers across system+user text, NULs, and oversized strings. Emails, phones, and IPs that pass are redacted.
5. **Output inspection.** Model responses are pattern-screened and contact-redacted before they become `governed_output_v1`.
6. **Report scrub.** Generated report text is scrubbed for emails, IPs, phones, AWS keys, token prefixes, optional organization names, and contextual person names (`src/services/privacyService.ts`). Audit evidence quotes are treated more conservatively than generated narrative.

**Honest boundary:** these are deterministic pattern screens and policy approval. They reduce risk; they are not proof of public classification or comprehensive PII prevention. Source material still requires human review before sharing.

Implementation: `src/services/deterministicPrivacyService.ts`, `src/services/sourceRegistryService.ts`, `lib/governance.js`, `src/services/privacyService.ts`, `src/services/analysisService.ts`.

## 6. LLM egress governance

- The browser creates an authoritative server UUID run before governed packet or model processing.
- Approval stores canonical packet bytes in PostgreSQL `BYTEA` and content-free metadata separately. Redis holds coordination, leases, send-authorization fences, checkpoints, and governed results — not packet bodies.
- Dispatch reloads canonical bytes, recomputes SHA-256, and evaluates packet binding. Any mismatch is fail-closed and not eligible for provider fallback (`ADR-001` invariants 4–5).
- Provider invocation is at-most-once after Redis `SEND_AUTHORIZED`. Post-send uncertainty becomes `outcome_unknown`; it is never automatically retried or used as fallback.
- Output contracts are server-authorized JSON schemas with `additionalProperties: false` (`lib/outputContracts.js`). Client-supplied schemas are rejected.
- Evidence-gap analysis may propose search terms only. Deterministic local matching searches the privacy-approved Source Registry; remote KB bodies are not inputs to that stage.

Implementation: `lib/governance.js`, `lib/providerGateway.js`, `lib/providerInvocation.js`, `lib/executionWorker.js`, `lib/outputContracts.js`, `docs/architecture/ADR-001-execution-and-evidence-lineage.md`.

## 7. Retention, cleanup, and logging

| Store | Content | Lifetime / cleanup |
|-------|---------|--------------------|
| Browser `sessionStorage` | Completed report for crash recovery | Until the tab/session is cleared |
| PostgreSQL packet bodies | Canonical governed request bytes | Deleted after acknowledged delivery, terminal failure/deletion, or expiry |
| Redis | Coordination, checkpoints, governed results | Deadline-capped; results recoverable up to 30 minutes |
| PostgreSQL metadata | Content-free run/packet/attempt records and hashes | 90 days |
| RunTrace | Hashes, source references, report-visible snippets | No raw source files, full prompts, or API keys |

- Cleanup evidence uses fixed codes, counts, and timestamps — never content. Deletion from platform or database backups is not claimed.
- Client and worker logs filter to known events and safe identifier/number/boolean fields (`lib/operationalLogPolicy.js`, `lib/workerOperationalLog.js`).
- API failures map to an allowlisted `safeErrorCode`; unknown exceptions become `INTERNAL_ERROR` (`lib/safeErrors.js`). Server request failures log the code, not a stack dump to the client.

Implementation: `lib/controlPlanePolicy.js`, `lib/runLifecycleService.js`, `lib/operationalLogPolicy.js`, `lib/workerOperationalLog.js`, `lib/safeErrors.js`, `src/services/runTraceService.ts`.

## 8. Integrity, availability, and abuse resistance

- Health: `/livez` is process liveness; `/readyz` checks PostgreSQL and Redis and returns 503 while shutting down.
- SIGTERM/SIGINT drain HTTP, stop workers, and close pools.
- Advisory locks, `FOR UPDATE`, and Redis leases/tombstones protect claim, send-authorization, and cleanup races.
- JSON body size limits, packet text length caps (500k input / 1M output), OCR page/pixel caps, and source-record count caps bound resource use.
- Table cells with residual sensitive values can be withheld from model context (`src/services/tableService.ts` / table-cell-withhold tests).

There is **no** application-level login rate limit, CAPTCHA, WAF config in-repo, or HTTP security-header middleware (`Content-Security-Policy`, `X-Frame-Options`, and similar are not set by `server.js`).

## 9. Automated regression coverage

These focused tests encode the practices above. Prefer extending them over adding a parallel security story:

| Script | Contract covered |
|--------|------------------|
| `npm run test:governance` | Packet approval, secret/PII/image rejection, hash binding, output inspection, authorized contracts |
| `npm run test:privacy` | Report and generated-text redaction |
| `npm run test:dlp-distributed` | Distributed DLP sampling, not first-chunk-only |
| `npm run test:internal-call-protection` | Packet-ID-only gateway, PostgreSQL body of record, no Redis packet bodies, send fence |
| `npm run test:operational-logging` | Log allowlists drop prompts, filenames, and source text |
| `npm run test:model-routing` | Fail-closed role policy |
| `npm run test:source-registry` | Hostile filenames, XML escaping, schema fail-closed |
| `npm run test:table-cell-withhold` | Sensitive table cells withheld from model context |
| `npm run test:provider-invocation` | Server-side provider call shape and capability checks |

CI (`.github/workflows/test.yml`) runs `npm ci`, migrations, the full `npm test` suite, `npm run build`, and infrastructure integration against PostgreSQL 16 and Redis 7.

## Known gaps (do not paper over)

Use this list when someone asks whether the Engine is “secure by default” for production:

- Shared-password authentication; no per-user accounts, MFA, or RBAC.
- `SECRET_KEY` dual-use as password and HMAC key.
- No login rate limiting or account lockout.
- No in-app CSRF token (relies on `SameSite=Lax` plus session cookie).
- No CSP / clickjacking / HSTS headers in `server.js` or `vercel.json`.
- `api/login.js` can return `err.message` on unexpected failures; governed routes use safe codes instead.
- DLP and governance screens are pattern-based risk reduction, not a data-classification guarantee.
- Provider, platform log, browser storage, and backup retention remain outside Engine deletion.
- Hosting on Vercel cannot execute governed assessments; Railway is the supported dispatch target.

## PR review checklist

A change is consistent with current practice when all of the following hold:

- [ ] No provider key, `SECRET_KEY`, `DATABASE_URL`, or `REDIS_URL` is readable from client code or `VITE_*` defines.
- [ ] New `/api/*` assessment routes call `requireSession` and reject unknown JSON keys.
- [ ] New SQL uses bound parameters. New logs use allowlisted, content-free fields.
- [ ] Prompt or packet changes keep customer text inside `<UNTRUSTED_CONTENT>` / approved packet parts and do not add image/base64 payloads.
- [ ] New model destinations go through `authorizeDestination` / `authorizeConfiguredDestination` and fail closed when unconfigured.
- [ ] Privacy/DLP block-severity patterns still fail the assessment rather than redacting-and-continuing.
- [ ] Packet identity still binds ID, canonical-byte hash, run, provider, model, and stage before send.
- [ ] Client-visible errors stay in the `safeErrorCode` set.
- [ ] Tests in the table above are updated when the contract changes.
