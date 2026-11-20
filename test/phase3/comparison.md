# Phase 3 comparison set at 7028188

The two Master Data exports dated 20 November 2026 are display-only reader baselines. Scores below use the rounding shown to readers. Keep the original exports outside the repository.

| Input | Classification | Adjusted maturity | Assessed criteria | Sufficiency | Quality Gate | Planning decision | Published roadmap |
|---|---|---:|---:|---|---|---|---|
| Clear-Go.html | Walk | 38% | 38/60 | PASS | WARN | CONDITIONAL GO | Yes |
| Near-Warn-Conditional-Go.html | Crawl | 23% | 20/60 | PASS | WARN | CONDITIONAL GO | Yes |
| Clear BLOCK synthetic result in test-strategy-sanitation | Insufficient evidence | 4.8 diagnostic only | 5/60 | BLOCK | BLOCK | NO_GO | Empty |
| Legacy synthetic result in test-report-import | Run | Unavailable | Unavailable | PASS | GO | Unavailable | Empty |

Original export SHA-256, in table order:

- Clear-Go: 24c495c5ea154c1f190ddcce6a70f0c25a630c83a49bd753dbeef3b078258255
- Near-Warn: 5c16bd48c63ac4c0c8a202c92a6ae041c1f28b8d21dd8176785bc2a5e3a34912

Claim-level expectations frozen before changing the writer or checker:

1. Both reservation samples use 75% as a utilization review threshold. Portfolio coverage targets and completed exchanges remain unverified.
2. Clear-Go's sampled worker already scales horizontally with queue depth, within a floor of two and a ceiling of twelve workers. Vertical scaling and scale-to-zero remain unverified.
3. Near-Warn's Culture & Organization has zero eligible criteria. Ask for evidence before prescribing a change.
4. BLOCK exposes no execution actions. The reader may review scoped observations, collect evidence and rerun.

Run the executable controls with `npm run test:strategy-sanitation` and `npm run test:report-import`. The synthetic controls exercise publication and restore independently of the HTML.
