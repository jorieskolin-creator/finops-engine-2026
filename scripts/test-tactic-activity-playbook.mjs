import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

const tacticsDb = await readJson('../src/knowledge_base/finops_tactics_database.json');
const playbookDb = await readJson('../src/knowledge_base/finops_tactic_activity_playbook.json');
const criteriaDb = await readJson('../src/knowledge_base/finops_criteria.json');
const antipatternDb = await readJson('../src/knowledge_base/finops_antipatterns.json');

const tactics = tacticsDb.tactics || [];
const validTacticIds = new Set(tactics.map(t => t.id));
const validMaturityIds = new Set(criteriaDb.criteria.map(c => c.id));
const validAntipatternIds = new Set(antipatternDb.criteria.map(c => `AP-${c.id}`));
const domainByMaturity = new Map(criteriaDb.criteria.map(c => [c.id, c.batch]));
const domainByAntipattern = new Map(antipatternDb.criteria.map(c => [`AP-${c.id}`, c.batch]));
const relationships = new Set(['PRIMARY', 'SUPPORTING', 'RELATED']);

assert.equal(playbookDb.schema_version, '1.0.0');
assert.equal(playbookDb.playbook_id, 'FINOPS-TACTIC-PLAYBOOK');
const entries = playbookDb.tactics || [];
assert.equal(entries.length, tactics.length, 'playbook should have one enriched entry per tactic');

const seen = new Set();
const coveredDomains = new Set();
const coveredMaturity = new Set();
const coveredAntipattern = new Set();

for (const entry of entries) {
  assert.ok(validTacticIds.has(entry.tactic_id), `${entry.tactic_id} must exist in tactics DB`);
  assert.ok(!seen.has(entry.tactic_id), `${entry.tactic_id} must be unique`);
  seen.add(entry.tactic_id);

  assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(entry.category), `${entry.tactic_id} needs a valid home category`);
  assert.ok(entry.maturity_bindings.length > 0 || entry.antipattern_bindings.length > 0, `${entry.tactic_id} must bind to KB criteria`);
  assert.ok(entry.implementation_activities.length >= 3, `${entry.tactic_id} needs practical activities`);
  assert.ok(entry.expected_artifacts.length >= 2, `${entry.tactic_id} needs expected artifacts`);
  assert.ok(entry.semantic_hints.length >= 2, `${entry.tactic_id} needs focused semantic hints`);
  assert.ok(entry.acceptance_criteria.length >= 2, `${entry.tactic_id} needs acceptance criteria`);
  assert.ok(entry.risks_and_controls.length >= 1, `${entry.tactic_id} needs risk-control guidance`);

  for (const binding of entry.maturity_bindings) {
    const id = binding.criterion_id;
    assert.ok(validMaturityIds.has(id), `${entry.tactic_id} maps to invalid maturity criterion ${id}`);
    assert.ok(relationships.has(binding.relationship), `${entry.tactic_id}/${id} has invalid relationship`);
    coveredMaturity.add(id);
    coveredDomains.add(domainByMaturity.get(id));
  }
  for (const binding of entry.antipattern_bindings) {
    const id = binding.criterion_id;
    assert.ok(validAntipatternIds.has(id), `${entry.tactic_id} maps to invalid anti-pattern criterion ${id}`);
    assert.ok(relationships.has(binding.relationship), `${entry.tactic_id}/${id} has invalid relationship`);
    assert.equal(binding.mandatory_when_activated, binding.relationship === 'PRIMARY', `${entry.tactic_id}/${id} mandatory flag must match PRIMARY relationship`);
    coveredAntipattern.add(id);
    coveredDomains.add(domainByAntipattern.get(id));
  }
}

for (const tactic of tactics) {
  assert.ok(seen.has(tactic.id), `${tactic.id} is missing from playbook`);
}

for (const domain of ['A', 'B', 'C', 'D', 'E', 'F']) {
  assert.ok(coveredDomains.has(domain), `domain ${domain} must have tactic/playbook coverage`);
}

const uncoveredMaturity = criteriaDb.criteria.map(c => c.id).filter(id => !coveredMaturity.has(id));
const uncoveredAntipattern = antipatternDb.criteria.map(c => `AP-${c.id}`).filter(id => !coveredAntipattern.has(id));
assert.deepEqual(uncoveredMaturity, [], 'all maturity criteria need Playbook coverage');
assert.deepEqual(uncoveredAntipattern, [], 'all anti-pattern criteria need Playbook coverage');

console.log(`tactic activity playbook validation passed (${entries.length} entries)`);
console.log(`maturity criteria covered: ${coveredMaturity.size}/${validMaturityIds.size}`);
console.log(`anti-pattern criteria covered: ${coveredAntipattern.size}/${validAntipatternIds.size}`);
if (uncoveredMaturity.length) console.log(`maturity criteria without direct tactic coverage: ${uncoveredMaturity.join(', ')}`);
if (uncoveredAntipattern.length) console.log(`anti-pattern criteria without direct tactic coverage: ${uncoveredAntipattern.join(', ')}`);
