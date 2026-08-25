# ADR-002: Resolution-based FinOps maturity model

Status: Active. The resolution-based model and Assessment Sufficiency gate are
the authoritative maturity calculation as of 2026-08-25.

## Context

The legacy headline model assigns unknown capability and anti-pattern criteria
zero points across the complete framework surface, averages Capability
Attainment and Anti-Pattern Control, and caps the resulting score at 70 when
the Quality Gate blocks. This mixes three separate concepts: observed maturity,
assessment completeness, and roadmap actionability.

## Decision

The active model keeps unknown evidence out of maturity arithmetic and
represents it through explicit resolution.

The three target headline views are:

1. **Corroborated Maturity**: weighted pair maturity using only pairs for which
   both capability and anti-pattern sides are resolved.
2. **Observed Maturity and Resolution**: the weighted signal from fully or
   partially resolved pairs, displayed with the percentage of the configured
   framework that is resolved.
3. **Adjusted FinOps Maturity**: Observed Maturity multiplied by
   `Resolution^gamma`; it is publishable and classifiable only when Assessment
   Sufficiency passes.

Capability and anti-pattern dispositions remain visible diagnostic dimensions,
but are no longer independent headline maturity gauges after activation.

## Normalized states

A capability with governed, provenance-bound evidence has value `count / 3`.
An unassessed or verification-unresolved capability is `NA`, not zero.

Anti-pattern health preserves the complete 0/3 through 3/3 scale:

- governed `tested_absent` at 0/3: `1.0`;
- resolved presence at 1/3: `2/3`;
- resolved presence at 2/3: `1/3`;
- resolved `confirmed_present` at 3/3: `0.0`;
- `unknown_absent` or verification unresolved: `NA`.

The calculation input must be produced after provenance reconciliation and must
recognize direct evidence, approved substantive derived evidence, and governed
tested absence. Acquisition diagnostics and KB material cannot resolve a score.

## Pair scoring

Pair relationships come only from the versioned canonical pair registry. The
engine must never infer a relationship from matching identifiers.

For a fully resolved pair:

`P = (1-r) * ((C+H)/2) + r * sqrt(C*H)`

`r` is the registered interaction strength and `w` is the registered positive
weight. Corroborated Maturity uses the same fully resolved pair set in both its
numerator and denominator. If that set is empty, the result is unavailable.

Observed Maturity uses resolution credit `1.0` when both sides are resolved,
`0.5` when exactly one side is resolved, and `0.0` when neither side is
resolved. A single-sided signal is the known normalized side. Resolution keeps
the total configured pair weight in its denominator.

Adjusted Maturity initially uses `gamma = 0.5`. The initial classification
boundaries remain 33 and 66 for test-run comparability. Gamma, boundaries,
weights, strengths, and sufficiency thresholds are calibration parameters and
must be versioned when changed.

Contradictions are explicit pair outcomes, not values averaged away. A strong
capability signal combined with a materially harmful anti-pattern signal must
remain visible even when the pair formula is numerically low.

## Gate separation

**Assessment Sufficiency** (`PASS | BLOCK`) owns score publication and
CRAWL/WALK/RUN availability. It uses evidence-lane inputs such as overall
resolution, criterion evidence density, provenance integrity, verification
status, and packet readiness. KB completeness is not an input.

The existing **Quality Gate** (`GO | WARN | BLOCK`) continues to own roadmap
actionability. It must not mutate a calculated maturity score. An
assessment-integrity blocker may block both decisions; a strategy-only blocker
must not rewrite evidence-based maturity.

Assessment Sufficiency policy v2 uses hard publication floors of 30% criterion
evidence density and 30% overall resolution, provenance integrity 100%, no
unresolved verification, and a ready effective Evidence Package. Density and
resolution from 30% through less than 60% pass with explicit evidence warnings.

Per-domain resolution is telemetry, not a global blocker. The engine separately
calculates verified criterion evidence density for each domain. A domain with
strictly less than 10% density is `silent`: it cannot support a broad domain
maturity conclusion or remediation tactics, but it must produce bounded
evidence-collection guidance and does not prevent supported domains from being
assessed. Exactly 10% is not silent. Source packet `weak_coverage` remains an
acquisition and retrieval warning; it cannot suppress findings or roadmap
actions after verified criterion evidence has been established.

## Incremental activation

1. **Implemented:** canonical active pair registry.
2. **Implemented:** provenance-reconciled criterion resolution records.
3. **Implemented:** active model calculation and versioned Phase 2 contract.
4. **Implemented:** synthetic calibration baseline and aggregate RunTrace data.
5. **Implemented:** authoritative Assessment Sufficiency gate.
6. **Implemented:** three active gauges in the Engine, Summary Report, and
   Master Data report, plus prompt, fact-check, checkpoint, and recovery use.
7. **Implemented:** removal of the legacy average as scoring authority and of
   the Quality Gate 70-point score cap. Legacy dimensions remain diagnostics.

Historical scores retain their original formula version and are not silently
recomputed or treated as directly comparable with the replacement formula.
