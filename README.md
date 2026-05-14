# FinOps Engine

Evidence-gated FinOps Maturity Assessment scanner. React + TypeScript + Vite frontend; Gemini and Anthropic providers proxied through Vercel serverless functions under `api/`.

## Local development

The client always calls `/api/generate` and `/api/anthropic-generate`, so local
dev needs the serverless functions running too. Use `vercel dev` (it serves
the Vite frontend and the `api/*.js` functions together):

```bash
npm install
cp .env.example .env.local   # fill in API_KEY and ANTHROPIC_API_KEY
npx vercel dev               # http://localhost:3000
```

`npm run dev` (plain Vite) still works for UI-only work, but any audit run will
fail because `/api/*` won't be served.

## Deployment (Vercel)

1. Import the repo into Vercel.
2. Set environment variables in **Project Settings → Environment Variables**:
   - `GEMINI_API_KEY` — Google Gemini key (server-side only, never exposed to browser)
   - `SECRET_KEY` — access password for running assessments; also the HMAC key for session cookies. Pick a long random string (>= 32 chars).
   - `VITE_FINOPS_TACTICS_URL` — optional public Blob URL for the tactics DB
   - `ANTHROPIC_API_KEY` — optional, only if you re-enable the Anthropic path
3. Build command: `npm run build` (default). Output: `dist/`.
4. The serverless functions in `api/` are auto-registered by Vercel; `vercel.json` grants them up to 600s execution.

Secrets are **not** inlined into the client bundle — `vite.config.ts` only exposes `VITE_*` vars. All Gemini/Anthropic traffic from the browser goes through `/api/generate` and `/api/anthropic-generate`.

### Access control

The UI loads for anyone, but **running an assessment requires logging in.** Login is a single shared password held in `SECRET_KEY`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/login` | POST `{password}` | Verifies password (timing-safe), sets an HMAC-signed `fe_session` cookie (HttpOnly, SameSite=Lax, 8h TTL). |
| `/api/logout` | POST | Clears the cookie. |
| `/api/session` | GET | Returns 200 if the cookie is valid, 401 otherwise. |
| `/api/generate`, `/api/anthropic-generate` | POST | Reject with 401 if the cookie is missing or invalid. |

Implementation lives in `lib/auth.js` (`node:crypto` only — no external deps, no Vercel-specific code, so it ports cleanly to any Node host). The cookie is signed with HMAC-SHA256 keyed by `SECRET_KEY`, so rotating `SECRET_KEY` invalidates all active sessions.

### Model configuration

Model IDs **and thinking config** are centralized in `src/models.ts` as `ModelProfile` objects. During technical testing the engine uses Gemini only:

| Phase | Constant | Model ID | Thinking config |
|-------|----------|----------|-----------------|
| Phase 0 (DLP) + Phase 1 (5 parallel batch audits) | `MODEL_PHASE1` | `gemini-3-flash-preview` | `{ thinkingLevel: 'low' }` |
| Phase 3 (strategy synthesis) | `MODEL_PHASE3` | `gemini-2.5-pro` | `{ thinkingBudget: -1 }` (dynamic) |

Gemini 3 uses `thinkingLevel` (`'low' | 'medium' | 'high'`); Gemini 2.5 uses `thinkingBudget` (integer; `-1` dynamic, `0` off-Flash-only). The two cannot be combined in one request. The `thinkingConfig` object is plumbed from `src/models.ts` → `callGeminiGenerate` → `/api/generate` → the SDK's `generateContent({ config: { thinkingConfig } })`.

The Anthropic path (`src/services/anthropicService.ts`, `api/anthropic-generate.js`) is left dormant. Re-enable by swapping the Phase 3 call in `src/services/geminiService.ts` back to `callOpusStrategy` and adding `ANTHROPIC_API_KEY` to the platform env vars.

### Drift Test (MVP)

A **Drift Test** button appears in the header once you're logged in. Click it to run the assessment pipeline against the three bundled golden fixtures (`test/golden-{crawl,walk,run}.txt`) combined into a single document set. The result shows on the normal report screen; download the HTML via "Review & Download Report" and diff against previous runs manually.

This MVP intentionally does not store results anywhere. The plan once the procedure is validated:
1. Persist each drift run (Vercel Blob → Postgres) and add a history view.
2. Add per-criterion count-delta + score-delta computation against `src/knowledge_base/golden_baselines.json`.
3. Add embedding-based similarity on the Phase 3 executive summary.
4. Add an `ADMIN_SECRET` gate for write/destructive operations once admin actions exist.

The golden fixtures are bundled via Vite `?raw` imports in `src/App.tsx`, so the client ships them — no static-asset route needed.

## Deployment (Railway)

Railway can host the same build via its Vite preset; configure the same env vars in the service settings. Note that `api/*.js` are written for the Vercel function runtime — running on Railway as a Node server would require a small adapter.

---

## Golden Test Corpus for Drift Detection

Synthetic FinOps documents with known maturity profiles. Used to detect when Gemini model updates silently change scoring behavior.

## Documents

| File | Profile | Expected Classification | Purpose |
|------|---------|------------------------|---------|
| `golden-crawl.txt` | Immature org | Crawl | Low maturity, high anti-patterns |
| `golden-walk.txt` | Partially mature | Walk | Mix of signals |
| `golden-run.txt` | Mature org | Run | High maturity, low anti-patterns |

## How to Use

1. Upload each golden document pair (you need 2+ files per assessment) to the engine
2. Run assessment
3. Compare Phase 1 scores against `knowledge_base/golden_baselines.json`
4. Use `services/driftDetectionService.ts` to automate the comparison

## When to Run

- After every Gemini model update
- Before every production release
- Quarterly as a baseline check

## Important

These are **synthetic** documents. Do not modify them — their content is calibrated to the expected score ranges in `golden_baselines.json`. If you change the criteria definitions, update the baselines accordingly.
