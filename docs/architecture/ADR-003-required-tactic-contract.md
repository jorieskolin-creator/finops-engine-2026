# ADR-003: Required roadmap tactic disposition contract

Status: Accepted

## Context

The governed tactic selection plan can require roadmap tactics for verified
findings. Fact-check sanitation may remove or rewrite a tactic citation. A
later fact-check escalation previously replaced the sanitation lineage, making
the final contract unable to distinguish a verified contraindication from a
rejected citation or an unexplained omission.

## Decision

Every required tactic ends with exactly one disposition:

- `accepted`: the final roadmap contains the required tactic ID;
- `contraindicated`: roadmap sanitation removed the ID after the Quality
  Checker explicitly established a supplied Playbook do-not-use condition;
- `citation_rejected`: roadmap sanitation removed the ID because its citation
  or use was unsupported or mismatched; or
- `missing`: the final roadmap omits the ID without a valid reviewed
  disposition.

Only `contraindicated` satisfies the required-tactic contract without the
tactic appearing in the roadmap. Sanitation items and their explicit
dispositions are accumulated across scoped repair and fact-check escalation;
they are not reconstructed from the final roadmap.

After initial sanitation, `citation_rejected` and `missing` required tactics
receive one bounded roadmap-only synthesis repair. The evidence summary and
diagnosis remain locked. Explicitly contraindicated tactics are excluded from
the repair selection plan. Only the repaired roadmap is re-fact-checked and
sanitized. There is no repeated repair loop.

If citation-rejected or missing required tactics remain, Quality Gate stays
`BLOCK`. The contract does not weaken the existing fact-check or Quality Gate
thresholds.

RunTrace exports the original governed selection plan, sanitation history,
final dispositions, strictly missing IDs, all unresolved IDs, and whether the bounded repair was
attempted and succeeded under `required_tactic_contract`.

## Invariants

1. Presence in the final roadmap is sufficient only for `accepted`.
2. Absence is a valid exception only with an explicit `contraindicated`
   sanitation disposition.
3. `citation_rejected` is repairable, not an exception.
4. Fact-check escalation preserves prior sanitation lineage.
5. Repair may change only the roadmap; it cannot change evidence, findings,
   diagnosis, maturity scores, or the governed activation plan.
6. Silent domains do not activate remediation tactics. Packet weakness alone
   does not deactivate tactics for otherwise verified findings.
