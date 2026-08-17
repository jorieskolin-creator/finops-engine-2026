import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModelRouting } from '../lib/modelRoutingPolicy.js';

const env = {
  OPENAI_API_KEY: 'test-openai-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  XAI_API_KEY: 'test-xai-key',
  REASONER_PROVIDER: 'OPENAI', REASONER_MODEL: 'gpt-5.6-sol',
  REASONER_FALLBACK_PROVIDER: 'XAI', REASONER_FALLBACK_MODEL: 'grok-4.6',
  WORKHORSE_PROVIDER: 'ANTHROPIC', WORKHORSE_MODEL: 'claude-sonnet-5',
  WORKHORSE_FALLBACK_PROVIDER: 'XAI', WORKHORSE_FALLBACK_MODEL: 'grok-4.6',
  QUALITY_CHECKER_PROVIDER: 'XAI', QUALITY_CHECKER_MODEL: 'grok-4.6',
  QUALITY_CHECKER_FALLBACK_PROVIDER: 'ANTHROPIC', QUALITY_CHECKER_FALLBACK_MODEL: 'claude-sonnet-5',
};
const routing = resolveModelRouting(env);
const dir = await mkdtemp(join(tmpdir(), 'finops-role-fallback-'));

const runCase = async ({ primaryText, expectedProvider, expectedAttempts }) => {
  const outfile = join(dir, `${expectedProvider}-${expectedAttempts}.mjs`);
  await build({
    entryPoints: [new URL('../src/services/modelRouter.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  const { runStage } = await import(`file://${outfile}`);
  const approvals = new Map();
  const approvedRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/model-routing') return Response.json(routing);
    if (url === '/api/log') return Response.json({ ok: true });
    if (url === '/api/governed-packet') {
      const request = JSON.parse(options.body);
      approvedRequests.push(request);
      const packet = {
        ...request,
        schema_version: 'approved_stage_packet_v1',
        packet_id: `packet-${request.provider}`,
        packet_hash: crypto.createHash('sha256').update(request.provider).digest('hex'),
        classification_method: 'deterministic_pattern_screen_v1',
        approval_basis: 'policy_approved_after_pattern_screening',
      };
      approvals.set(packet.packet_id, packet);
      return Response.json(packet, { status: 201 });
    }
    if (/^\/api\/(anthropic|xai)-generate$/.test(String(url))) {
      const request = JSON.parse(options.body);
      const approval = approvals.get(request.packet_id);
      const text = approval.provider === 'anthropic' ? primaryText : '{"valid":true}';
      const output = {
        schema_version: 'governed_output_v1',
        policy_version: 'llm_egress_policy_v1',
        inspection_status: 'passed',
        inspection_method: 'deterministic_pattern_screen_and_contact_redaction_v1',
        run_id: request.run_id,
        stage: request.stage,
        provider: approval.provider,
        model: approval.model,
        source_packet_id: approval.packet_id,
        source_packet_hash: approval.packet_hash,
        text,
        char_count: text.length,
        output_hash: crypto.createHash('sha256').update(text).digest('hex'),
      };
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
    const result = await runStage('forensic_audit', originalPrompt, { runId: 'run-role-test' });
    assert.equal(result.modelUsed.provider, expectedProvider);
    assert.equal(result.attempts.length, expectedAttempts);
    assert.equal(approvedRequests.length, expectedAttempts + 1);
    for (const request of approvedRequests) {
      assert.equal(request.parts[0].text, originalPrompt.userText);
      assert.match(request.system_instruction, /AI ROLE: WORKHORSE/);
      assert.match(request.system_instruction, /Return one JSON object\./);
    }
    assert.equal(new Set(approvedRequests.map(request => request.parts[0].text)).size, 1);
    assert.equal(new Set(approvedRequests.map(request => request.system_instruction)).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

await runCase({ primaryText: '{"valid":true}', expectedProvider: 'anthropic', expectedAttempts: 0 });
await runCase({ primaryText: '{"valid":false}', expectedProvider: 'xai', expectedAttempts: 1 });

console.log('AI role primary and validated fallback tests passed');
