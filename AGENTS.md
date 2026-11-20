# AGENTS.md — FinOps Assessment Engine

Repository-specific instructions for **FinOps Assessment Engine** (`jorieskolin-creator/finops-engine-2026`).
Organization-wide engineering, PR, and Railway/Vercel safety rules also apply automatically.

## 1. What this repository is
- **Frontend (`src/`):** React 18 + TypeScript + Vite SPA. Parses source artifacts in the browser (including local Tesseract OCR via `tesseract.js` and spreadsheet extraction via the SheetJS worker), runs deterministic pre-flight privacy/DLP gates and structured-data table analyzers, and renders display-only Summary and Master Data HTML reports plus JSON assessment exports.
- **Governed API & Execution Plane (`server.js`, `api/`, `lib/`):** Node.js ESM (`>=18`) + Express long-lived service packaged for Railway (`railway.json`). Mounts `api/*.js` handlers, enforces HMAC-signed `fe_session` cookies, approves and hashes text-only stage packets (`lib/governance.js`), and runs `OutboxPublisher`, `ExecutionWorker`, `AttemptReconciler`, and `CleanupWorker` across OpenAI, Anthropic, and xAI (`lib/modelRoutingPolicy.js`, `lib/providerGateway.js`).
- **Control & Execution Stores (`migrations/`):** PostgreSQL 16 authoritative control plane + transient canonical `BYTEA` packet bodies (`DATABASE_URL`); Redis 7 deadline-capped coordination, `SEND_AUTHORIZED` fences, checkpoints, and recoverable governed results (`REDIS_URL`). Optional read-only remote reference KB PDF index on Vercel Blob (`BLOB_READ_WRITE_TOKEN` via `/api/kb-index`).
- **Hosting boundary:** Railway is the supported governed-dispatch target. Vercel (`vercel.json`) may serve UI/prototype previews only; `/api/run`, `/api/checkpoint`, and governed packet/model endpoints intentionally fail closed (`VERCEL_GOVERNED_DISPATCH_UNSUPPORTED`) without initialized PostgreSQL/Redis worker infrastructure.

## 2. Authoritative documentation (in order)
1. `docs/architecture/ADR-001-execution-and-evidence-lineage.md` — lineage vocabulary, canonical packet binding, catalog-only gap retrieval, and dispatch invariants.
2. `docs/architecture/ADR-002-resolution-based-maturity-model.md` — active resolution-based maturity formula (`Corroborated`, `Observed + Resolution`, `Adjusted`) and `Assessment Sufficiency` vs. `Quality Gate` separation.
3. `docs/architecture/ADR-003-required-tactic-contract.md` — required roadmap tactic dispositions (`accepted`, `contraindicated`, `citation_rejected`, `missing`) and bounded single-pass roadmap repair.
4. `docs/architecture/maturity-model-calibration-baseline.md` — executable synthetic calibration scenarios and monotonicity invariants.
5. `src/knowledge_base/finops_taxonomy_registry.json` (and governed sibling registries in `src/knowledge_base/*.json`) — canonical A–F domains, streams, 60 criteria, 30 capability/anti-pattern pairs, tactic playbook, and evidence categories.
6. `docs/security/secure-coding-practices.md` — evaluated security, DLP, governed LLM egress, retention, and PR review checklist.
7. `README.md` and this file (`AGENTS.md`).

Root HTML reference decks (`architecture.html`, `finops-engine-clean-room-protocol.html`, `tactic-playbook.html`) are visual documentation artifacts, not runtime scoring or governance contracts; do not overwrite or regenerate them unless explicitly asked.

## 3. Verification commands
Run all checks relevant to your change before pushing or opening a PR:

- **Install locked dependencies:** `npm ci`
- **TypeScript type-check:** `npx tsc --noEmit`
- **Production build (stages OCR assets + `tsc` + Vite bundle):** `npm run build`
- **Full offline test suite (discovers and runs all `test:*` scripts):** `npm test`
- **Live PostgreSQL + Redis migration & infrastructure integration check** (run against disposable local/CI `DATABASE_URL` and `REDIS_URL` whenever changing `migrations/`, `server.js`, `api/run.js`, `api/checkpoint.js`, `lib/infrastructure.js`, `lib/controlPlane*.js`, `lib/redisExecutionPlane.js`, `lib/executionWorker.js`, or `lib/runLifecycleService.js`, matching `.github/workflows/test.yml`):
  `npm run migrate && npm run integration`

If local PostgreSQL/Redis services are not running in your sandbox and your change does not touch infrastructure/SQL, state explicitly in the PR description that `npm test`, `npx tsc --noEmit`, and `npm run build` ran locally and that `npm run migrate && npm run integration` runs in GitHub Actions CI.

## 4. Non-negotiable invariants
- **Models author bounded semantics; code owns admission, scoring, gates, IDs, hashes, and state.** Model stages (`REASONER`, `WORKHORSE`, `QUALITY_CHECKER`) never assign run/packet IDs, hashes, maturity arithmetic, `Assessment Sufficiency` (`PASS | BLOCK`), or `Quality Gate` (`GO | WARN | BLOCK`) decisions.
- **Fail closed everywhere.** Partial or legacy model-routing env policies, unknown JSON keys, schema mismatches, DLP block-severity patterns, packet-binding or SHA-256 mismatches, and unsupported Vercel governed dispatch reject requests with allowlisted `safeErrorCode` values rather than silently degrading.
- **At-most-once post-fence provider invocation.** After Redis records `SEND_AUTHORIZED`, transport or crash uncertainty becomes `outcome_unknown` — never automatically retried and never eligible for provider fallback.
- **Customer evidence vs. reference KB separation.** Reference KB documents and derived coverage diagnostics (`finops_crucial_items.json`, shadow telemetry) must never be cited as customer quotes or resolve customer maturity/anti-pattern scores. Domains without eligible customer evidence or approved substantive derived evidence record `Not assessed` locally and skip forensic audit and Evidence Check model dispatch.
- **Catalog-only pre-audit gap requests.** `evidence_gap_analysis` accepts only catalog IDs under `finops_evidence_gap_input_v1` (`lib/evidenceGapRequest.js`), never free-form text or customer snippets, and local near-matches require customer FinOps scope plus criterion corroboration.
- **Resolution-based maturity & gate separation (`ADR-002`).** Unknown or verification-unresolved criteria stay `NA` (never averaged as zero). `Assessment Sufficiency` owns score/classification publication; `Quality Gate` owns roadmap actionability and never caps or rewrites maturity scores.
- **Display-only HTML exports.** Newly generated Summary and Master Data HTML must not embed `finops-data`, hidden JSON, or scripts; saved assessments restore from explicit JSON downloads (legacy HTML import remains backward-compatible only).
- **Append-only SQL migrations.** Never edit applied historical migrations in `migrations/001_*.sql`..`009_*.sql`; add a new sequential `NNN_<slug>.sql` migration (`scripts/migrate.mjs` skips already-applied versions recorded in `schema_versions`).

## 5. Data, secrets, deployment, and test isolation
- Keep `npm test` completely offline using local fixtures and injected stubs; never call live OpenAI, Anthropic, or xAI APIs or read/write live Railway databases or Vercel Blob storage during tests or verification.
- Synthetic files under `test/` are engineering boundary inputs only — never describe them as Golden Standard reference packs, accuracy certification, or drift certification.
- Never read, print, hardcode, or commit `.env`, `.env.local`, or secret values (`SECRET_KEY`, `OPENAI_API_KEY`, `GPT_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `BLOB_READ_WRITE_TOKEN`, or Railway tokens). Keep all credentials strictly server-side (`VITE_FINOPS_TACTICS_URL` is the only client-exposed `VITE_*` variable).
- Keep operational logs, cleanup evidence, and client-facing errors content-free (codes, hashes, counts, timestamps — never raw source text, filenames, or prompts).
- Do not modify `railway.json` or `vercel.json` deployment routing, deploy to Railway, or mutate live Vercel Blob storage unless explicitly requested and approved by the owner.

## 6. Architecture & change boundaries
- **Shared governance & runtime contracts:** Treat `lib/modelRoutingPolicy.js`, `lib/governance.js`, `lib/evidenceGapRequest.js`, `lib/outputContracts.js`, `lib/providerGateway.js`, `lib/operationalLogPolicy.js`, `lib/safeErrors.js`, and `src/types.ts` as shared contracts — check both backend (`server.js`, `api/`, `lib/`) and frontend (`src/`) callers plus focused contract tests before changing fields, schemas, or allowlists.
- **Governed Knowledge Base registries (`src/knowledge_base/*.json`):** Domain eligibility, 30 pair bindings, 23 tactic playbook entries, and theme bindings are integrity-checked by `test:maturity-pair-registry`, `test:tactic-activity-playbook`, `test:theme-bindings`, `test:scale-readiness`, and `test:domain-dispatch`. Do not invent ad hoc IDs, pair weights, or analyzer semantics.
- **Core pipeline & UI modules:** `src/orchestrator.ts`, `src/services/analysisService.ts`, `src/App.tsx`, `src/components/ReportView.tsx`, `src/prompts.ts`, and `src/knowledge_base/index.ts` are large core modules: keep edits narrowly scoped and avoid unrelated refactors.
- **PR & review discipline:** Work on a dedicated branch per task, review `git diff` against the checklist in `docs/security/secure-coding-practices.md` when touching auth, packets, prompts, SQL, or logs, and open a Pull Request for human review and merge.
