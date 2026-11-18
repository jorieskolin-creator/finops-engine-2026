import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveRequest, authorizeConfiguredDestination, inspectOutput } from '../lib/governance.js';
import { MODEL_STAGES, resolveModelRouting, settingsForProfile } from '../lib/modelRoutingPolicy.js';

const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const env = {
  ...Object.fromEntries([...example.matchAll(/^(\w+(?:_PROVIDER|_MODEL))=(\S+)$/gm)].map(([, key, value]) => [key, value])),
  OPENAI_API_KEY: 'test-openai-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  XAI_API_KEY: 'test-xai-key',
};
const routing = resolveModelRouting(env);
assert.throws(() => resolveModelRouting({ ...env, ANTHROPIC_API_KEY: '' }), /MODEL_ROUTING_CONFIGURATION_INVALID/);
for (const stage of MODEL_STAGES) {
  for (const profile of routing.routes[stage]) {
    authorizeConfiguredDestination(stage, profile.provider, profile.id, settingsForProfile(profile), env);
  }
}

const runCase = async (runStage, { stage, role, expectedModels, rejectPrimary }) => {
  const approvals = new Map();
  const approvedRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/model-routing') return Response.json(routing);
    if (url === '/api/log') return Response.json({ ok: true });
    if (url === '/api/governed-packet') {
      const request = JSON.parse(options.body);
      approvedRequests.push(request);
      authorizeConfiguredDestination(request.stage, request.provider, request.model, request.settings, env);
      const packet = approveRequest(request);
      approvals.set(packet.packet_id, packet);
      return Response.json(packet, { status: 201 });
    }
    if (/^\/api\/(anthropic|openai|xai)-generate$/.test(String(url))) {
      const request = JSON.parse(options.body);
      const approval = approvals.get(request.packet_id);
      assert.equal(url, `/api/${approval.provider}-generate`);
      const text = JSON.stringify({ valid: !(rejectPrimary && approvedRequests.length === 1) });
      const output = inspectOutput(text, approval);
      return new Response(`${JSON.stringify({ type: 'done', output, usage: {} })}\n`);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const originalPrompt = {
      userText: 'bounded evidence packet',
      systemInstruction: 'Return one JSON object.',
      validateOutput: text => {
        const parsed = JSON.parse(text);
        if (parsed.valid !== true) throw Object.assign(new Error('invalid'), { code: 'INVALID_TEST_CONTRACT' });
      },
    };
    const result = await runStage(stage, originalPrompt, { runId: 'run-role-test' });
    const expectedAttempts = rejectPrimary ? 1 : 0;
    assert.equal(`${result.modelUsed.provider}:${result.modelUsed.id}`, expectedModels[expectedAttempts]);
    assert.equal(result.attempts.length, expectedAttempts);
    assert.deepEqual(approvedRequests.map(request => `${request.provider}:${request.model}`),
      expectedModels.slice(0, expectedAttempts + 1));
    for (const request of approvedRequests) {
      assert.equal(request.parts[0].text, originalPrompt.userText);
      assert.ok(request.system_instruction.includes(`AI ROLE: ${role}.`));
      assert.match(request.system_instruction, /Return one JSON object\./);
    }
    assert.equal(new Set(approvedRequests.map(request => request.parts[0].text)).size, 1);
    assert.equal(new Set(approvedRequests.map(request => request.system_instruction)).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const dir = await mkdtemp(join(tmpdir(), 'finops-role-fallback-'));
try {
  const outfile = join(dir, 'model-router.mjs');
  await build({
    entryPoints: [new URL('../src/services/modelRouter.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  const { runStage } = await import(`file://${outfile}`);
  for (const [stage, role, expectedModels] of [
    ['forensic_audit', 'WORKHORSE', ['openai:gpt-6.1-terra', 'xai:grok-4.7']],
    ['roadmap_synthesis', 'REASONER', ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.2-sol']],
    ['fact_check', 'QUALITY_CHECKER', ['xai:grok-4.7', 'openai:gpt-6.1-terra']],
  ]) {
    await runCase(runStage, { stage, role, expectedModels, rejectPrimary: false });
    await runCase(runStage, { stage, role, expectedModels, rejectPrimary: true });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('AI role primary and validated fallback tests passed');
