# FinOps Knowledge Base Taxonomy

The engine uses the same indexes for Knowledge Base content and assessment output. Keep new Vercel Blob documents aligned with `finops_taxonomy_registry.json`.

## Canonical domains

| ID | Domain | Capabilities |
|----|--------|--------------|
| A | Cost Visibility & Allocation | A1, A2, A3, A4, A5 |
| B | Rate & Usage Optimization | B1, B2, B3, B4, B5 |
| C | Governance & Policy | C1, C2, C3, C4, C5 |
| D | Architecture & Engineering | D1, D2, D3, D4, D5 |
| E | Culture & Organization | E1, E2, E3, E4, E5 |
| F | GenAI & AI Cost Management | F1, F2, F3, F4, F5 |

## Streams & 60-document corpus

Use `maturity` for target capability rubrics (`A1`–`F5`) and `antipattern` for harmful pattern rubrics (`AP-A1`–`AP-F5`). The governed remote Knowledge Base contains **60 single-criterion PDF documents** (`30` maturity + `30` anti-pattern), validated for set completeness (`buildKbStatus` in `lib/kbIndex.js`).

## Evidence categories

Declare one or more of the seven canonical evidence categories in each document's JSON front matter (`evidence_categories`): `Policy`, `Process`, `Operational`, `Automation`, `Accountability`, `Financial-Integration`, `Cultural`.

## Canonical document naming (`lib/kbIndex.js`)

```text
<Domain ID> - <Domain Name> - <Criterion ID (A1..F5 | AP-A1..AP-F5)> - <Canonical Criterion Title>.pdf
```

Examples:

```text
Knowledge Base/Cost Visibility & Allocation/A - Cost Visibility & Allocation - A1 - Comprehensive Cost Allocation & Tagging.pdf
Knowledge Base/Cost Visibility & Allocation/A - Cost Visibility & Allocation - AP-A1 - Tag Sprawl & Missing Tags.pdf
Knowledge Base/Governance & Policy/C - Governance & Policy - C1 - Cloud Financial Policy Framework.pdf
Knowledge Base/GenAI & AI Cost Management/F - GenAI & AI Cost Management - F2 - AI Cost Allocation & Unit Economics.pdf
```

Each PDF binds 1-to-1 to a single criterion (`maturity:A1..F5` or `antipattern:AP-A1..AP-F5`) so per-domain (`batchId`) and per-criterion (`criterionIds`) stage retrieval can extract exact rubric sections deterministically.

## Required JSON front matter

Every reference KB PDF must begin with a valid JSON front-matter object matching its filename identifiers and forbidding customer-evidence contamination:

```json
{
  "kb_type": "reference",
  "domain_id": "A",
  "domain_name": "Cost Visibility & Allocation",
  "stream": "maturity",
  "criterion_id": "A1",
  "capability_id": "A1",
  "capability_name": "Comprehensive Cost Allocation & Tagging",
  "evidence_categories": ["Policy", "Process", "Automation"],
  "allowed_uses": ["rubric_context", "evidence_requirements", "validation_questions"],
  "forbidden_uses": ["customer_current_state_claim", "source_evidence_quote"],
  "version": "1.0.0"
}
```

(For `stream: "antipattern"`, use `"criterion_id": "AP-A1"` and `"antipattern_name"` in place of `"capability_name"`.)

## Canonical section headings extracted per stage

`lib/kbIndex.js` parses standalone section headings into `doc.sections`, and `src/knowledge_base/index.ts` selects stage-relevant `[KB_SECTION]` blocks so late-document guardrails and remediation notes are never truncated behind introductory prose:

- **Phase 1 (`forensic_audit` / `targeted_rescan`) & `evidence_check`:** `Canonical Definition`, `Primary Assessment Questions`, `Maturity / Anti-Pattern State Interpretation`, `Evidence Requirements` (`Strong / Moderate / Weak / Contradictory Evidence`, `Accepted Evidence Types`), `False Positive Guards`, `Validation Questions`, `Detection Heuristics`, `Prohibited Inference Rules`, and `Scoring Guidance Notes`.
- **Phase 3 (`roadmap_synthesis`):** `Canonical Definition`, `Related Capabilities`, `Risk Notes`, `Remediation / Tactic Notes`, and `Prohibited Inference Rules` (scoped to active findings in non-silent domains).

Reference KB content guides scoring rubrics, false-positive checks, validation questions, tactic selection, prerequisites, and remediation wording. It must never be cited as proof that the assessed organization has a capability or anti-pattern.
