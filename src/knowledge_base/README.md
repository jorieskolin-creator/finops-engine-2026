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

## Streams

Use `maturity` for what good looks like and `antipattern` for harmful patterns. Always include the stream when a document is meant to support scoring logic; `A1` alone is ambiguous because both streams use A1-E5.

## Evidence categories

Use one or more of the existing evidence categories in each document name and front matter: `Policy`, `Process`, `Operational`, `Automation`, `Accountability`, `Financial-Integration`, `Cultural`.

## Recommended document name

```text
<Domain ID> - <Domain Name> - <Capability IDs> - <Evidence Categories> - <Short Title>
```

Examples:

```text
A - Cost Visibility & Allocation - A1 A2 A3 - Policy Process Operational - Allocation Examples
C - Governance & Policy - C1 C2 - Policy Automation Accountability - Budget Controls
E - Culture & Organization - E1 E3 E4 - Accountability Cultural - Operating Model Examples
```

This intentionally allows one document to cover several related capabilities and several evidence categories. Avoid over-fragmenting the KB into tiny single-criterion files unless the content is genuinely narrow.

## Required front matter for reference KB documents

Every reference/example document should declare that it cannot be used as customer evidence:

```json
{
  "forbidden_uses": ["customer_current_state_claim", "source_evidence_quote"]
}
```

Reference KB content may guide scoring rubrics, false-positive checks, validation questions, tactic selection, prerequisites, and remediation wording. It must never be cited as proof that the assessed organization has a capability or anti-pattern.
