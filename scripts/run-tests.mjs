import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const tests = Object.keys(packageJson.scripts).filter(name => name.startsWith('test:'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const test of tests) {
  console.log(`\n> ${test}`);
  const result = spawnSync(npm, ['run', test], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Unable to run ${test}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${test} failed with exit code ${result.status ?? 1}.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${tests.length} test scripts passed.`);
