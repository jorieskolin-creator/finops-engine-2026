import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initializeInfrastructure } from '../lib/infrastructure.js';
import { RunLifecycleService } from '../lib/runLifecycleService.js';
import {
  approveRequest,
  inspectOutput,
  POLICY_VERSION,
  STAGE_PACKET_REQUEST_VERSION,
  validateGovernedOutput,
} from '../lib/governance.js';
import { LIFETIMES_MS } from '../lib/controlPlanePolicy.js';

if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.error('INTEGRATION_INFRASTRUCTURE_REQUIRED');
  process.exit(1);
}

const infrastructure = await initializeInfrastructure();
const { repository, redis } = infrastructure;
const lifecycle = new RunLifecycleService({ repository, redis });

const makePacket = run => approveRequest({
  schema_version: STAGE_PACKET_REQUEST_VERSION,
  policy_version: POLICY_VERSION,
  run_id: run.run_id,
  stage: 'preflight',
  provider: 'openai',
  model: 'gpt-5.5',
  destination: 'openai:external_model',
  system_instruction: 'Inspect approved public material.',
  parts: [{ type: 'text', text: 'Public cloud governance summary.' }],
  settings: { max_tokens: 4096, reasoning_effort: 'low' },
});

const persistPacket = async (run, packet) => {
  const raw = JSON.stringify(packet);
  assert.equal(await redis.stagePacket({
    runId: run.run_id,
    packetId: packet.packet_id,
    body: raw,
    deadline: run.absolute_deadline_at,
    ttlMs: LIFETIMES_MS.packet,
  }), 1);
  assert.ok(await repository.commitPacket({
    packetId: packet.packet_id,
    runId: run.run_id,
    packetHash: packet.packet_hash,
    schemaVersion: packet.schema_version,
    policyVersion: packet.policy_version,
    classificationCode: packet.residual_classification,
    provider: packet.provider,
    model: packet.model,
    stage: packet.stage,
    partCount: packet.parts.length,
    charCount: packet.system_instruction.length + packet.parts[0].text.length,
  }));
  assert.equal(await redis.activatePacket({
    runId: run.run_id,
    packetId: packet.packet_id,
    deadline: run.absolute_deadline_at,
    ttlMs: LIFETIMES_MS.packet,
  }), 1);
  return raw;
};

try {
  const run = await repository.createRun();
  const packet = makePacket(run);
  const raw = await persistPacket(run, packet);
  const internalCallId = crypto.randomUUID();
  const binding = {
    packetId: packet.packet_id,
    packetHash: packet.packet_hash,
    runId: run.run_id,
    provider: packet.provider,
    model: packet.model,
    stage: packet.stage,
    internalCallId,
  };
  const attempt = await repository.claimPacketAndReserve(binding);
  assert.equal(attempt.state, 'queued');
  assert.equal((await repository.claimPacketAndReserve(binding)).attempt_id, attempt.attempt_id);
  assert.equal(await repository.claimPacketAndReserve({ ...binding, internalCallId: crypto.randomUUID() }), null);

  const owner = crypto.randomUUID();
  const outbox = await repository.claimPendingOutbox(owner);
  assert.ok(outbox.some(row => row.attempt_id === attempt.attempt_id));
  const eventId = await redis.notifyAttempt(attempt.attempt_id);
  assert.equal(typeof eventId, 'string');
  const published = outbox.find(row => row.attempt_id === attempt.attempt_id);
  assert.equal(await repository.markPublished(published.outbox_id, owner), true);

  const leased = await repository.claimAttempt(attempt.attempt_id, owner, 60);
  assert.ok(leased);
  assert.ok(await repository.transitionAttempt(attempt.attempt_id, 'queued', 'dispatch_intent'));
  assert.equal(await redis.setLease(run.run_id, attempt.attempt_id, leased.lease_token, run.absolute_deadline_at, 65_000), 1);
  assert.equal(await redis.authorizeSend({
    runId: run.run_id,
    attemptId: attempt.attempt_id,
    packetId: packet.packet_id,
    packetBody: raw,
    token: leased.lease_token,
    deadline: run.absolute_deadline_at,
    ttlMs: LIFETIMES_MS.packet,
  }), 1);
  assert.ok(await repository.authorizeAttempt(attempt.attempt_id, owner, leased.lease_token));

  const output = inspectOutput('Governed integration result.', packet);
  assert.equal(await redis.setResult({
    runId: run.run_id,
    id: attempt.attempt_id,
    value: JSON.stringify({ status: 'done', output, usage: { output_tokens: 3 } }),
    deadline: run.absolute_deadline_at,
    ttlMs: LIFETIMES_MS.resultRecovery,
  }), 1);
  assert.ok(await repository.recoverSucceeded(attempt.attempt_id, { outputTokens: 3 }));
  const stored = JSON.parse(await redis.getResult(run.run_id, attempt.attempt_id));
  validateGovernedOutput(stored.output, {
    source_packet_id: packet.packet_id,
    source_packet_hash: packet.packet_hash,
    run_id: run.run_id,
    stage: packet.stage,
    provider: packet.provider,
    model: packet.model,
  });
  const completed = await lifecycle.completeWithQuality(run.run_id, {
    schema_version: 'acquisition_quality_snapshot_v1', formula_version: 'acquisition_quality_formula_v1',
    extraction_completeness: 100, evidence_coverage: 100, evidence_density: 100,
    provenance_integrity: 100, kb_completeness: 100, evidence_packet_status: 'READY',
    knowledge_packet_status: 'READY', acquisition_status: 'READY', security_status: 'PASS',
    extraction_incomplete_count: 0, weak_source_packet_count: 0, kb_blocking_count: 0,
    unresolved_provenance_count: 0,
  });
  assert.equal(completed.cleanup_status, 'verified');
  assert.equal(await redis.getActivePacket(run.run_id, packet.packet_id), null);
  assert.equal(await redis.getResult(run.run_id, attempt.attempt_id), null);

  // Terminalizing between the Redis fence and PostgreSQL CAS must prohibit send.
  const stoppedRun = await repository.createRun();
  const stoppedPacket = makePacket(stoppedRun);
  const stoppedRaw = await persistPacket(stoppedRun, stoppedPacket);
  const stoppedAttempt = await repository.claimPacketAndReserve({
    packetId: stoppedPacket.packet_id,
    packetHash: stoppedPacket.packet_hash,
    runId: stoppedRun.run_id,
    provider: stoppedPacket.provider,
    model: stoppedPacket.model,
    stage: stoppedPacket.stage,
    internalCallId: crypto.randomUUID(),
  });
  const stoppedOwner = crypto.randomUUID();
  const stoppedLease = await repository.claimAttempt(stoppedAttempt.attempt_id, stoppedOwner, 60);
  await repository.transitionAttempt(stoppedAttempt.attempt_id, 'queued', 'dispatch_intent');
  await redis.setLease(stoppedRun.run_id, stoppedAttempt.attempt_id, stoppedLease.lease_token, stoppedRun.absolute_deadline_at, 65_000);
  assert.equal(await redis.authorizeSend({
    runId: stoppedRun.run_id,
    attemptId: stoppedAttempt.attempt_id,
    packetId: stoppedPacket.packet_id,
    packetBody: stoppedRaw,
    token: stoppedLease.lease_token,
    deadline: stoppedRun.absolute_deadline_at,
    ttlMs: LIFETIMES_MS.packet,
  }), 1);
  await repository.terminalRun(stoppedRun.run_id, 'failed', 'INTEGRATION_TEST');
  assert.equal(await repository.authorizeAttempt(stoppedAttempt.attempt_id, stoppedOwner, stoppedLease.lease_token), null);
  assert.equal((await lifecycle.transition(stoppedRun.run_id, 'failed', 'INTEGRATION_TEST')).cleanup_status, 'verified');

  console.log('infrastructure integration tests passed');
} finally {
  await infrastructure.close();
}
