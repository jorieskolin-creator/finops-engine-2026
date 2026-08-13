import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../src/services/jsonResponseService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-json-response-'));
const modulePath = join(dir, 'jsonResponseService.mjs');
await writeFile(modulePath, compiled, 'utf8');
const { parseGovernedJsonObject, validateFindingsModePayload } = await import(`file://${modulePath}`);

const payload = {
  phase_3_strategy: {
    findings_mode: {
      evidence_backed_findings: ['one', 'two', 'three', 'four'],
      candidate_themes: ['one', 'two', 'three'],
      missing_evidence: ['one', 'two', 'three', 'four'],
      validation_plan: ['one', 'two', 'three'],
    },
  },
};
const json = JSON.stringify(payload);

assert.deepEqual(parseGovernedJsonObject(json), payload, 'plain JSON must parse');
assert.deepEqual(parseGovernedJsonObject(`\`\`\`json\n${json}\n\`\`\``), payload, 'recognized JSON fences must parse');
assert.deepEqual(parseGovernedJsonObject(`Here is the result:\n${json}\nEnd.`), payload, 'one balanced JSON object may be extracted from prose');
assert.deepEqual(parseGovernedJsonObject('{"message":"brace } and escaped \\\"{ text","nested":{"items":[{"ok":true}]}}'), {
  message: 'brace } and escaped \"{ text',
  nested: { items: [{ ok: true }] },
}, 'braces in quoted strings must not terminate extraction');
assert.throws(() => parseGovernedJsonObject(`[${json}]`), /malformed/, 'valid array roots must be rejected');
assert.throws(() => parseGovernedJsonObject(`${json}\n{"other":true}`), /malformed/, 'multiple objects must be rejected');
assert.throws(() => parseGovernedJsonObject(`}${json}`), /malformed/, 'leading unmatched braces must be rejected');
assert.throws(() => parseGovernedJsonObject(`${json}}`), /malformed/, 'trailing unmatched braces must be rejected');
assert.throws(() => parseGovernedJsonObject(json.slice(0, -1)), /malformed/, 'truncated JSON must be rejected');
assert.throws(() => parseGovernedJsonObject('{"__proto__":{"polluted":true}}'), /malformed/, 'dangerous keys must be rejected');
assert.deepEqual(validateFindingsModePayload(payload), [], 'valid findings contract must pass');

for (const key of ['evidence_backed_findings', 'candidate_themes', 'missing_evidence', 'validation_plan']) {
  const missing = structuredClone(payload);
  delete missing.phase_3_strategy.findings_mode[key];
  assert.ok(validateFindingsModePayload(missing).some(error => error.includes(key)), `${key} must be required`);
}
const wrongItem = structuredClone(payload);
wrongItem.phase_3_strategy.findings_mode.validation_plan[1] = { invented: true };
assert.ok(validateFindingsModePayload(wrongItem).some(error => error.includes('non-empty strings')), 'finding items must be strings');
const tooFew = structuredClone(payload);
tooFew.phase_3_strategy.findings_mode.missing_evidence = ['only one'];
assert.ok(validateFindingsModePayload(tooFew).some(error => error.includes('4-8')), 'contract item bounds must be enforced');

console.log('governed JSON response tests passed');
