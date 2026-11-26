import { createHash } from 'node:crypto';
import { requireSession } from '../lib/auth.js';
import { getInfrastructure } from '../lib/infrastructure.js';
import { goldenStandardCase, validClearBlockObservation } from '../lib/goldenStandardClearBlock.js';
import { cases, packageVersion } from '../lib/goldenStandardCases.js';
import { resolveModelRouting } from '../lib/modelRoutingPolicy.js';
import { RunLifecycleService } from '../lib/runLifecycleService.js';
import { GoldenStandardSuiteRepository } from '../lib/goldenStandardSuiteRepository.js';
import { compareSuiteCase, numericChecks } from '../lib/goldenStandardSuiteComparison.js';

const ids = Object.keys(cases);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`, 'i').test(value);
const fields = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
const enumJudgments = ['Supported', 'Missing', 'Contradicted', 'Needs judgment'];
const routingHash = routing => createHash('sha256').update(JSON.stringify(routing)).digest('hex');
const runtimeBuild = () => [process.env.RAILWAY_GIT_COMMIT_SHA, process.env.GIT_COMMIT_SHA, process.env.VERCEL_GIT_COMMIT_SHA]
  .find(value => hash(value, 40)) ?? null;

function validObservation(caseId, observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
  const { numbers, kbHash, assessed, ...basic } = observation;
  return Array.isArray(numbers) && numbers.length === numericChecks[caseId].length
    && numbers.every(number => number === null || (Number.isFinite(number) && Math.abs(number) <= 1e9))
    && (kbHash === null || hash(kbHash, 64))
    && Number.isInteger(assessed) && assessed >= 0 && assessed <= 60
    && validClearBlockObservation(basic);
}

export function goldenStandardSuiteHandler({ store, lifecycle, loadCase = goldenStandardCase,
  readRouting = () => resolveModelRouting(process.env), readBuild = runtimeBuild }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!requireSession(req)) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    const invalid = () => res.status(400).json({ error: 'INVALID_REQUEST' });
    const conflict = () => res.status(409).json({ error: 'GOLDEN_STANDARD_STATE_CONFLICT' });
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
        if (routingHash(routing) !== expectedRouting || (readBuild() && readBuild() !== build)) return conflict();
        const configuration = {
          build, routingHash: expectedRouting, routingLabel: routing.label, deepMode, packageVersion,
          references: Object.fromEntries(ids.map(id => [id, cases[id].reference.sha256])),
          models: Object.fromEntries(Object.entries(routing.roles).map(([role, detail]) =>
            [role, detail.profiles.map(profile => `${profile.provider}/${profile.id}`)])),
        };
        if (!await store.start(suiteId, configuration, selection === 'all' ? ids : [selection], repetitions)) return conflict();
        return res.status(201).json(await store.read(suiteId));
      }
      if (action === 'cancel' && fields(req.body, ['action', 'suiteId'])) {
        const pending = await store.cancel(suiteId);
        await Promise.allSettled(pending.map(id => lifecycle.transition(id, 'deletion_requested')));
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
      if (action === 'finish' && fields(req.body, ['action', 'suiteId', 'ordinal', 'runId', 'observation'])) {
        const { observation } = req.body;
        if (!validObservation(attempt.case_id, observation)) return invalid();
        const card = await loadCase(attempt.case_id).loadReference();
        const sha256 = cases[attempt.case_id].reference.sha256;
        if (sha256 !== suite.configuration.references[attempt.case_id] || suite.configuration.packageVersion !== packageVersion) return conflict();
        const { compact, reviewCard } = compareSuiteCase(attempt.case_id, card, sha256, observation);
        if (!await store.finish(suiteId, ordinal, runId, compact)) return conflict();
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
      return res.status(503).json({ error: error?.message === 'GOLDEN_STANDARD_INTEGRITY'
        ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE' });
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
  })(req, res);
}
