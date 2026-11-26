import { createHash } from 'node:crypto';
import { requireSession } from '../lib/auth.js';
import { getInfrastructure } from '../lib/infrastructure.js';
import { inspectOutput, sha256 as sha256Hex } from '../lib/governance.js';
import { goldenStandardCase, comparisonForCard, validClearBlockObservation } from '../lib/goldenStandardClearBlock.js';
import { cases, packageVersion } from '../lib/goldenStandardCases.js';
import { resolveModelRouting } from '../lib/modelRoutingPolicy.js';
import { RunLifecycleService } from '../lib/runLifecycleService.js';
import { GoldenStandardSuiteRepository } from '../lib/goldenStandardSuiteRepository.js';
import { compareSuiteCase, numericChecks } from '../lib/goldenStandardSuiteComparison.js';
import { workerOperationalLog } from '../lib/workerOperationalLog.js';

const ids = Object.keys(cases);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`, 'i').test(value);
const fields = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
const enumJudgments = ['Supported', 'Missing', 'Contradicted', 'Needs judgment'];
const validCrawlWalkRun = ['Insufficient evidence', 'Crawl', 'Walk', 'Walk with significant friction', 'Run'];
const validFailureStages = ['input_download', 'input_parse', 'pipeline', 'cleanup', 'delivery'];
const routingHash = routing => createHash('sha256').update(JSON.stringify(routing)).digest('hex');
const runtimeBuild = () => [process.env.RAILWAY_GIT_COMMIT_SHA, process.env.GIT_COMMIT_SHA, process.env.VERCEL_GIT_COMMIT_SHA]
  .find(value => hash(value, 40)) ?? null;

const safeReason = error => typeof error?.code === 'string' && /^GOLDEN_STANDARD_[A-Z0-9_]{1,48}$/.test(error.code)
  ? error.code
  : error?.message === 'GOLDEN_STANDARD_INTEGRITY' ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE';

const validPercentOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const validNonNegativeInt = (value, max = 10_000) => Number.isInteger(value) && value >= 0 && value <= max;

function validMonitoring(monitoring) {
  if (!fields(monitoring, [
    'crawlWalkRun', 'corroboratedMaturity', 'observedMaturity', 'adjustedMaturity',
    'assessmentResolution', 'criterionEvidenceDensity', 'antipatternBurden',
    'assessedCriteria', 'admittedCustomerSources', 'expectedCustomerSources', 'factCheck',
  ])) return false;
  if (!validCrawlWalkRun.includes(monitoring.crawlWalkRun)
    || !validPercentOrNull(monitoring.corroboratedMaturity)
    || !validPercentOrNull(monitoring.observedMaturity)
    || !validPercentOrNull(monitoring.adjustedMaturity)
    || !validPercent(monitoring.assessmentResolution)
    || !validPercent(monitoring.criterionEvidenceDensity)
    || !validPercent(monitoring.antipatternBurden)
    || !Array.isArray(monitoring.assessedCriteria) || monitoring.assessedCriteria.length > 60
    || new Set(monitoring.assessedCriteria).size !== monitoring.assessedCriteria.length
    || !monitoring.assessedCriteria.every(id => typeof id === 'string' && /^(?:maturity|antipattern)\.[A-F][1-5]$/.test(id))
    || !validNonNegativeInt(monitoring.admittedCustomerSources, 32)
    || !validNonNegativeInt(monitoring.expectedCustomerSources, 32)
    || monitoring.admittedCustomerSources > monitoring.expectedCustomerSources) return false;
  const fc = monitoring.factCheck;
  return fields(fc, ['totalClaims', 'supportedClaims', 'unsupportedClaims', 'sanitizedClaims', 'byCategory'])
    && validNonNegativeInt(fc.totalClaims)
    && validNonNegativeInt(fc.supportedClaims)
    && validNonNegativeInt(fc.unsupportedClaims)
    && validNonNegativeInt(fc.sanitizedClaims)
    && fields(fc.byCategory, ['evidence', 'inference', 'scope', 'other'])
    && Object.values(fc.byCategory).every(count => validNonNegativeInt(count));
}

function validObservation(caseId, observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
  const { numbers, kbHash, assessed, monitoring, ...basic } = observation;
  if (monitoring !== undefined && !validMonitoring(monitoring)) return false;
  return Array.isArray(numbers) && numbers.length === numericChecks[caseId].length
    && numbers.every(number => number === null || (Number.isFinite(number) && Math.abs(number) <= 1e9))
    && (kbHash === null || hash(kbHash, 64))
    && Number.isInteger(assessed) && assessed >= 0 && assessed <= 60
    && validClearBlockObservation(basic);
}

const validBoundedString = (value, maxLength) => typeof value === 'string' && value.length <= maxLength;
const validStringList = (list, maxItems, maxLength) => Array.isArray(list) && list.length <= maxItems
  && list.every(item => validBoundedString(item, maxLength));

function sanitizeSummary(summary, runId) {
  if (summary === undefined || summary === null) return null;
  if (!fields(summary, ['headline', 'bottleneck', 'planningRationale', 'keyMetrics', 'narrative'])
    || !validBoundedString(summary.headline, 600)
    || !validBoundedString(summary.bottleneck, 500)
    || !validBoundedString(summary.planningRationale, 500)
    || !validStringList(summary.keyMetrics, 8, 260)
    || !fields(summary.narrative, ['diagnosis', 'planning', 'masterData'])
    || !validStringList(summary.narrative.diagnosis, 30, 600)
    || !validStringList(summary.narrative.planning, 30, 600)
    || !validStringList(summary.narrative.masterData, 50, 600)) {
    return undefined;
  }
  const serialized = JSON.stringify(summary);
  if (serialized.length > 65_536) return undefined;
  try {
    const inspected = inspectOutput(serialized, {
      packet_id: 'golden-standard-summary',
      packet_hash: 'golden-standard-summary',
      run_id: runId,
      stage: 'final_report',
      provider: 'internal',
      model: 'golden-standard-summary',
    }).text;
    return JSON.parse(inspected);
  } catch {
    return undefined;
  }
}

function validFailure(failure) {
  return fields(failure, ['stage', 'code', 'timedOut'])
    && validFailureStages.includes(failure.stage)
    && typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(failure.code)
    && typeof failure.timedOut === 'boolean';
}

async function verifyRunAgainstFinalReport({ repository, redis, runId, inputs, observation, existingServerVerified }) {
  if (!repository) return { ok: true, serverVerified: undefined };
  const run = await repository.getRun?.(runId);
  if (!run) return { ok: false, reason: 'RUN_NOT_FOUND' };

  if (run.state === 'ready_for_delivery' && redis && repository.listCheckpoints) {
    const checkpoints = await repository.listCheckpoints(runId);
    const finalCheckpoint = [...checkpoints].reverse().find(cp => cp.kind === 'final_report' && cp.state === 'available');
    if (finalCheckpoint) {
      const raw = await redis.getCheckpoint(runId, finalCheckpoint.checkpoint_id);
      if (!raw || sha256Hex(raw) !== finalCheckpoint.payload_hash) {
        return { ok: false, reason: 'GOLDEN_STANDARD_CHECKPOINT_UNAVAILABLE' };
      }
      const parsed = JSON.parse(raw);
      const result = parsed?.result;
      const manifest = result?.meta?.run_trace?.input_manifest;
      const metrics = result?.phase_2_validation?.metrics;
      const expectedHashes = inputs.map(entry => `sha256_${entry.sha256}`);
      const actualHashes = Array.isArray(manifest) ? manifest.map(entry => entry?.source_hash) : [];
      const actualAssessed = (metrics?.maturity_assessed_count ?? 0) + (metrics?.antipattern_assessed_count ?? 0);
      const actualPlanning = String(result?.phase_3_strategy?.planning_decision?.decision || 'NOT_AVAILABLE').replace(/_/g, ' ');
      if (result?.meta?.run_id !== runId
        || actualHashes.length !== expectedHashes.length
        || expectedHashes.some((expectedHash, index) => actualHashes[index] !== expectedHash)
        || result?.phase_2_validation?.assessment_sufficiency?.decision !== observation.evidenceSufficiency
        || result?.quality_gate?.decision !== observation.qualityGate
        || actualPlanning !== observation.planningDecision
        || actualAssessed !== observation.assessed) {
        return { ok: false, reason: 'GOLDEN_STANDARD_OBSERVATION_MISMATCH' };
      }
      return { ok: true, serverVerified: true, needsAcknowledge: true };
    }
    return { ok: true, serverVerified: existingServerVerified, needsAcknowledge: true };
  }

  if (run.state === 'completed' && run.cleanup_status === 'verified') {
    if (repository.db?.query) {
      const quality = (await repository.db.query(
        'SELECT evidence_coverage FROM run_quality_snapshots WHERE run_id=$1',
        [runId],
      )).rows?.[0];
      if (quality && Number(quality.evidence_coverage) !== Math.round((observation.assessed / 60) * 100)) {
        return { ok: false, reason: 'GOLDEN_STANDARD_OBSERVATION_MISMATCH' };
      }
    }
    return { ok: true, serverVerified: existingServerVerified, needsAcknowledge: false };
  }

  return { ok: false, reason: 'GOLDEN_STANDARD_CLEANUP_PENDING' };
}

export function goldenStandardSuiteHandler({
  store,
  lifecycle,
  repository,
  redis,
  loadCase = goldenStandardCase,
  readRouting = () => resolveModelRouting(process.env),
  readBuild = runtimeBuild,
}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!requireSession(req)) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    const invalid = () => res.status(400).json({ error: 'INVALID_REQUEST' });
    const conflict = (reason = 'GOLDEN_STANDARD_STATE_CONFLICT') => res.status(409).json({ error: 'GOLDEN_STANDARD_STATE_CONFLICT', reason });
    try {
      const query = req.query ?? {};
      const { caseId, input } = query;
      if (req.method === 'GET' && Object.keys(query).length === 0) return res.status(200).json(await store.history());
      if (req.method === 'GET' && ids.includes(caseId)) {
        if (fields(query, ['caseId'])) {
          const fixture = loadCase(caseId);
          const [files] = await Promise.all([fixture.loadInputs(), fixture.loadReference()]);
          return res.status(200).json({ files: files.map(({ path, bytes, sha256 }) => ({ name: path.split('/').at(-1), bytes, sha256 })) });
        }
        if (fields(query, ['caseId', 'card']) && query.card === '1') {
          const card = await loadCase(caseId).loadReference();
          const sha256 = cases[caseId].reference.sha256;
          return res.status(200).json(comparisonForCard(card, sha256, []));
        }
        if (!fields(query, ['caseId', 'input']) || typeof input !== 'string' || !/^(0|[1-9][0-9]?)$/.test(input)
          || Number(input) >= cases[caseId].files) return invalid();
        const fixture = loadCase(caseId);
        const entry = (await fixture.loadInputs())[Number(input)];
        const data = await fixture.read(entry);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(data);
      }
      if (req.method !== 'POST' || Object.keys(query).length > 0 || !uuid(req.body?.suiteId)) return invalid();
      const { action, suiteId, ordinal, runId } = req.body;
      if (action === 'start' && fields(req.body, ['action', 'suiteId', 'selection', 'repetitions', 'deepMode', 'build', 'routingHash'])) {
        const { selection, repetitions, deepMode, build, routingHash: expectedRouting } = req.body;
        if ((!ids.includes(selection) && selection !== 'all') || ![1, 3].includes(repetitions) || typeof deepMode !== 'boolean'
          || (build !== null && !hash(build, 40)) || !hash(expectedRouting, 64)) return invalid();
        const routing = readRouting();
        if (routingHash(routing) !== expectedRouting || (readBuild() && readBuild() !== build)) {
          return conflict('GOLDEN_STANDARD_CONFIGURATION_MISMATCH');
        }
        const selectedIds = selection === 'all' ? ids : [selection];
        await Promise.all(selectedIds.map(async id => {
          const fixture = loadCase(id);
          await Promise.all([fixture.loadInputs(), fixture.loadReference()]);
        }));
        const configuration = {
          build, routingHash: expectedRouting, routingLabel: routing.label, deepMode, packageVersion,
          references: Object.fromEntries(ids.map(id => [id, cases[id].reference.sha256])),
          models: Object.fromEntries(Object.entries(routing.roles).map(([role, detail]) =>
            [role, detail.profiles.map(profile => `${profile.provider}/${profile.id}`)])),
        };
        if (!await store.start(suiteId, configuration, selectedIds, repetitions)) {
          return conflict('GOLDEN_STANDARD_SUITE_ACTIVE');
        }
        workerOperationalLog('info', 'golden_standard_event', { action: 'start', suite_id: suiteId, case_id: selection });
        return res.status(201).json(await store.read(suiteId));
      }
      if (action === 'cancel' && fields(req.body, ['action', 'suiteId'])) {
        const pending = await store.cancel(suiteId);
        await Promise.allSettled(pending.map(id => lifecycle.transition(id, 'deletion_requested')));
        workerOperationalLog('info', 'golden_standard_event', { action: 'cancel', suite_id: suiteId });
        return res.status(200).json(await store.read(suiteId));
      }
      const suite = await store.read(suiteId);
      if (!suite) return res.status(404).json({ error: 'GOLDEN_STANDARD_SUITE_NOT_FOUND' });
      if (action === 'next' && fields(req.body, ['action', 'suiteId'])) {
        const next = await store.next(suiteId, routingHash(readRouting()), readBuild() ?? suite.configuration.build);
        return next ? res.status(200).json(next) : conflict();
      }
      if (!Number.isInteger(ordinal) || !uuid(runId)) return invalid();
      const attempt = suite.attempts.find(row => row.ordinal === ordinal && row.run_id === runId);
      if (!attempt) return conflict();
      if (action === 'fail' && fields(req.body, ['action', 'suiteId', 'ordinal', 'runId', 'failure'])) {
        const { failure } = req.body;
        if (!validFailure(failure)) return invalid();
        const recorded = await store.fail(suiteId, ordinal, runId, { ...failure, at: new Date().toISOString() });
        if (!recorded.recorded) return conflict();
        await Promise.allSettled(recorded.cleanupRunIds.map(id => lifecycle.transition(id, 'deletion_requested')));
        workerOperationalLog('warn', 'golden_standard_event', {
          action: 'fail',
          suite_id: suiteId,
          case_id: attempt.case_id,
          ordinal,
          run_id: runId,
          stage: failure.stage,
          error_code: failure.code,
        });
        return res.status(200).json(await store.read(suiteId));
      }
      const finishValid = action === 'finish' && (
        fields(req.body, ['action', 'suiteId', 'ordinal', 'runId', 'observation'])
        || fields(req.body, ['action', 'suiteId', 'ordinal', 'runId', 'observation', 'summary'])
      );
      if (finishValid) {
        const { observation, summary } = req.body;
        if (!validObservation(attempt.case_id, observation)) return invalid();
        const sanitizedSummary = sanitizeSummary(summary, runId);
        if (sanitizedSummary === undefined) return invalid();
        const fixture = loadCase(attempt.case_id);
        const [inputs, card] = await Promise.all([fixture.loadInputs(), fixture.loadReference()]);
        const sha256 = cases[attempt.case_id].reference.sha256;
        if (sha256 !== suite.configuration.references[attempt.case_id] || suite.configuration.packageVersion !== packageVersion) {
          return conflict();
        }
        const verification = await verifyRunAgainstFinalReport({
          repository,
          redis,
          runId,
          inputs,
          observation,
          existingServerVerified: attempt.comparison?.serverVerified,
        });
        if (!verification.ok) {
          workerOperationalLog('warn', 'golden_standard_event', {
            action: 'finish',
            suite_id: suiteId,
            case_id: attempt.case_id,
            ordinal,
            run_id: runId,
            error_code: verification.reason,
          });
          return conflict(verification.reason);
        }
        if (verification.needsAcknowledge && lifecycle?.acknowledgeDelivery) {
          const acknowledged = await lifecycle.acknowledgeDelivery(runId);
          if (acknowledged?.cleanup_status !== 'verified') {
            return res.status(503).json({ error: 'GOLDEN_STANDARD_UNAVAILABLE', reason: 'GOLDEN_STANDARD_CLEANUP_PENDING' });
          }
        }
        const { compact, reviewCard } = compareSuiteCase(attempt.case_id, card, sha256, observation, {
          serverVerified: verification.serverVerified,
        });
        if (!await store.finish(suiteId, ordinal, runId, compact, sanitizedSummary)) return conflict();
        workerOperationalLog('info', 'golden_standard_event', {
          action: 'finish',
          suite_id: suiteId,
          case_id: attempt.case_id,
          ordinal,
          run_id: runId,
        });
        return res.status(200).json({ comparison: reviewCard, suite: await store.read(suiteId) });
      }
      if (action === 'review' && fields(req.body, ['action', 'suiteId', 'ordinal', 'runId', 'referenceSha256', 'dispositions'])) {
        const { referenceSha256, dispositions } = req.body;
        const keys = attempt.comparison?.checkIds;
        if (!keys || !hash(referenceSha256, 64) || !fields(dispositions, keys)
          || !Object.values(dispositions).every(value => enumJudgments.includes(value))) return invalid();
        if (!await store.review(suiteId, ordinal, runId, referenceSha256, dispositions)) return conflict();
        return res.status(200).json(await store.read(suiteId));
      }
      return invalid();
    } catch (error) {
      const reason = safeReason(error);
      const code = reason === 'GOLDEN_STANDARD_INTEGRITY' ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE';
      workerOperationalLog('warn', 'golden_standard_event', {
        action: req.method === 'POST' ? String(req.body?.action || 'post') : 'get',
        suite_id: req.body?.suiteId,
        case_id: req.query?.caseId ?? req.body?.selection,
        run_id: req.body?.runId,
        error_code: reason,
        http_status: error?.httpStatus,
        blob_source: error?.blobSource,
      });
      return res.status(503).json({ error: code, reason });
    }
  };
}

export default function handler(req, res) {
  let infrastructure;
  try { infrastructure = getInfrastructure(); }
  catch { return res.status(503).json({ error: 'VERCEL_GOVERNED_DISPATCH_UNSUPPORTED' }); }
  const { repository, redis } = infrastructure;
  return goldenStandardSuiteHandler({
    store: new GoldenStandardSuiteRepository(repository),
    lifecycle: new RunLifecycleService({ repository, redis }),
    repository,
    redis,
  })(req, res);
}
