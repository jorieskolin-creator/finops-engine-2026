# ADR-002: Resolution-based FinOps maturity model

Status: Accepted for incremental implementation; registry is shadow-only until
the activation gate in this ADR is satisfied.

## Context

The legacy headline model assigns unknown capability and anti-pattern criteria
zero points across the complete framework surface, averages Capability
Attainment and Anti-Pattern Control, and caps the resulting score at 70 when
the Quality Gate blocks. This mixes three separate concepts: observed maturity,
assessment completeness, and roadmap actionability.

## Decision

The replacement model will keep unknown evidence out of maturity arithmetic and
represent it through explicit resolution. It will be implemented and reviewed
in versioned phases before replacing the live formula.

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
CRAWL/WALK/RUN availability. It uses evidence-lane inputs such as overall and
per-domain resolution, criterion evidence density, provenance integrity,
verification status, and packet readiness. KB completeness is not an input.

The existing **Quality Gate** (`GO | WARN | BLOCK`) continues to own roadmap
actionability. It must not mutate a calculated maturity score. An
assessment-integrity blocker may block both decisions; a strategy-only blocker
must not rewrite evidence-based maturity.

Illustrative initial sufficiency thresholds for shadow evaluation are criterion
evidence density 60%, overall resolution 65%, and every required domain at
least 40%. They are not active production thresholds until calibrated against
test runs.

## Incremental activation

1. **Implemented:** publish and validate the canonical registry without runtime
   score changes.
2. **Implemented:** build provenance-reconciled criterion resolution records.
3. **Implemented for checkpointed shadow evaluation:** calculate the new model
   in shadow mode and record formula/registry versions. It has no scoring,
   classification, prompt, report, Quality Gate, or roadmap authority.
4. **Synthetic baseline implemented; real-run review pending:** calibrate
   against synthetic scenarios and real test runs. Aggregate-only shadow values
   are exported in RunTrace to enable that review.
5. Add the authoritative Assessment Sufficiency gate.
6. Update reports, prompts, RunTrace, checkpoints, imports, and persistence.
7. Remove the legacy average and 70-point score cap only when all consumers use
   the versioned replacement contract.

Historical scores retain their original formula version and are not silently
recomputed or treated as directly comparable with the replacement formula.
