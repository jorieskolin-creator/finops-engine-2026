import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

const tacticsDb = await readJson('../src/knowledge_base/finops_tactics_database.json');
const playbookDb = await readJson('../src/knowledge_base/finops_tactic_activity_playbook.json');
const criteriaDb = await readJson('../src/knowledge_base/finops_criteria.json');
const antipatternDb = await readJson('../src/knowledge_base/finops_antipatterns.json');

const tactics = tacticsDb.tactics || [];
const entries = playbookDb.entries || [];
const validTacticIds = new Set(tactics.map(t => t.id));
const validMaturityIds = new Set(criteriaDb.criteria.map(c => c.id));
const validAntipatternIds = new Set(antipatternDb.criteria.map(c => `AP-${c.id}`));
const domainByMaturity = new Map(criteriaDb.criteria.map(c => [c.id, c.batch]));
const domainByAntipattern = new Map(antipatternDb.criteria.map(c => [`AP-${c.id}`, c.batch]));

assert.equal(entries.length, tactics.length, 'playbook should have one entry per tactic');

const seen = new Set();
const coveredDomains = new Set();
const coveredMaturity = new Set();
const coveredAntipattern = new Set();

for (const entry of entries) {
  assert.ok(validTacticIds.has(entry.tactic_id), `${entry.tactic_id} must exist in tactics DB`);
  assert.ok(!seen.has(entry.tactic_id), `${entry.tactic_id} must be unique`);
  seen.add(entry.tactic_id);

  assert.ok(entry.maturity_criteria.length > 0 || entry.antipattern_criteria.length > 0, `${entry.tactic_id} must map to KB criteria`);
  assert.ok(entry.implementation_activities.length >= 3, `${entry.tactic_id} needs practical activities`);
  assert.ok(entry.expected_artifacts.length >= 2, `${entry.tactic_id} needs expected artifacts`);
  assert.ok(entry.acceptance_criteria.length >= 2, `${entry.tactic_id} needs acceptance criteria`);

  for (const id of entry.maturity_criteria) {
    assert.ok(validMaturityIds.has(id), `${entry.tactic_id} maps to invalid maturity criterion ${id}`);
    coveredMaturity.add(id);
    coveredDomains.add(domainByMaturity.get(id));
  }
  for (const id of entry.antipattern_criteria) {
    assert.ok(validAntipatternIds.has(id), `${entry.tactic_id} maps to invalid anti-pattern criterion ${id}`);
    coveredAntipattern.add(id);
    coveredDomains.add(domainByAntipattern.get(id));
  }
}

for (const tactic of tactics) {
  assert.ok(seen.has(tactic.id), `${tactic.id} is missing from playbook`);
}

for (const domain of ['A', 'B', 'C', 'D', 'E']) {
  assert.ok(coveredDomains.has(domain), `domain ${domain} must have tactic/playbook coverage`);
}

const uncoveredMaturity = criteriaDb.criteria.map(c => c.id).filter(id => !coveredMaturity.has(id));
const uncoveredAntipattern = antipatternDb.criteria.map(c => `AP-${c.id}`).filter(id => !coveredAntipattern.has(id));

console.log(`tactic activity playbook validation passed (${entries.length} entries)`);
console.log(`maturity criteria covered: ${coveredMaturity.size}/25`);
console.log(`anti-pattern criteria covered: ${coveredAntipattern.size}/25`);
if (uncoveredMaturity.length) console.log(`maturity criteria without direct tactic coverage: ${uncoveredMaturity.join(', ')}`);
if (uncoveredAntipattern.length) console.log(`anti-pattern criteria without direct tactic coverage: ${uncoveredAntipattern.join(', ')}`);
