# Resolution-based maturity shadow calibration baseline

Status: Synthetic baseline implemented. Real-run calibration is pending.

This baseline fixes the expected behavior of
`resolution_based_maturity_formula_v1` with pair registry `1.0.0` and
`gamma = 0.5`. It is executable through `npm run test:maturity-calibration`.

| Scenario | Corroborated | Observed | Resolution | Adjusted |
| --- | ---: | ---: | ---: | ---: |
| No evidence | N/A | N/A | 0.0% | N/A |
| Fully healthy | 100.0% | 100.0% | 100.0% | 100.0% |
| Fully adverse | 0.0% | 0.0% | 100.0% | 0.0% |
| Capability 2/3 and anti-pattern presence 1/3 throughout | 66.7% | 66.7% | 100.0% | 66.7% |
| High capabilities only | N/A | 100.0% | 50.0% | 70.7% |
| Six perfect pairs, all others unknown | 100.0% | 100.0% | 20.0% | 44.7% |
| Five domains perfect, domain F unknown | 100.0% | 100.0% | 83.3% | 91.3% |
| Capabilities full; 15 anti-patterns tested absent and 15 confirmed present | 51.7% | 51.7% | 100.0% | 51.7% |

The final scenario has standalone anti-pattern health of exactly 50%. Pair
maturity is 51.7% because `STRONGLY_RELATED` and `CONTEXTUAL` relationships
retain their registered arithmetic component instead of behaving as direct
inverses.

The sparse and domain-blind scenarios demonstrate why Adjusted Maturity cannot
authorize publication or CRAWL/WALK/RUN by itself. A separate Assessment
Sufficiency gate must test both overall and per-domain resolution. The initial
65% overall and 40% per-required-domain thresholds remain hypotheses until real
test runs are reviewed.

RunTrace now exports aggregate-only shadow results under
`resolution_maturity_shadow`. It excludes criterion records, pair records,
quotes, source identifiers, and chunk identifiers. This is calibration
telemetry only and has `scoring_authority: false`.
