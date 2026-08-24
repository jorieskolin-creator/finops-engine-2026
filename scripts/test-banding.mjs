import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-banding-'));
const outfile = await emitTypescript(new URL('../src/services/derivedEvidence/banding.ts', import.meta.url).pathname, dir);
const {
  coverageBand, magnitudeBand, variabilityBand, persistenceBand, concentrationBandFromHhi, agingBand, cadenceBand, associationStrength, organizationalReach,
} = await import(`file://${outfile}`);

assert.equal(coverageBand(0), '0_25');
assert.equal(coverageBand(24.9), '0_25');
assert.equal(coverageBand(25), '25_50');
assert.equal(coverageBand(49.9), '25_50');
assert.equal(coverageBand(50), '50_75');
assert.equal(coverageBand(75), '75_90');
assert.equal(coverageBand(90), '90_100');
assert.equal(coverageBand(100), '90_100');
assert.equal(magnitudeBand(0.049), 'LT_5_PERCENT');
assert.equal(magnitudeBand(0.05), '5_10');
assert.equal(magnitudeBand(0.10), '10_20');
assert.equal(magnitudeBand(0.20), '20_50');
assert.equal(magnitudeBand(0.50), 'GT_50');
assert.equal(variabilityBand(0.09), 'LOW');
assert.equal(variabilityBand(0.10), 'MODERATE');
assert.equal(variabilityBand(0.30), 'MODERATE');
assert.equal(variabilityBand(0.31), 'HIGH');
assert.equal(persistenceBand(5, 6), 'SUSTAINED');
assert.equal(persistenceBand(3, 6), 'INTERMITTENT');
assert.equal(persistenceBand(1, 6), 'SINGLE_PERIOD');
assert.equal(concentrationBandFromHhi(0.14), 'EVEN');
assert.equal(concentrationBandFromHhi(0.15), 'MODERATE');
assert.equal(concentrationBandFromHhi(0.26), 'HIGH');
assert.equal(agingBand(6), 'LT_7D');
assert.equal(agingBand(7), '7_30D');
assert.equal(agingBand(30), '30_90D');
assert.equal(agingBand(90), 'GT_90D');
assert.equal(cadenceBand(7), 'WEEKLY');
assert.equal(cadenceBand(30), 'MONTHLY');
assert.equal(cadenceBand(90), 'QUARTERLY');
assert.equal(cadenceBand(180), 'AD_HOC');
assert.equal(associationStrength(0.29), 'NO_MATERIAL_ASSOCIATION');
assert.equal(associationStrength(0.3), 'WEAK');
assert.equal(associationStrength(0.6), 'MODERATE');
assert.equal(associationStrength(0.8), 'STRONG');
assert.equal(organizationalReach(39), 'NARROW');
assert.equal(organizationalReach(40), 'PARTIAL');
assert.equal(organizationalReach(75), 'BROAD');

console.log('banding tests passed');
