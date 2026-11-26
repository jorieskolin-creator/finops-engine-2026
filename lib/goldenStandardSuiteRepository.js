const selectAttempt = `SELECT a.*, r.cleanup_status,
  CASE WHEN a.state = 'running' AND ((a.run_id IS NOT NULL AND r.run_id IS NULL)
    OR r.state IN ('failed', 'deleted', 'expired', 'deletion_requested')
    OR r.effective_expires_at <= clock_timestamp()) THEN 'incomplete' ELSE a.state END AS state
  FROM golden_standard_attempts a LEFT JOIN runs r USING(run_id)`;

export class GoldenStandardSuiteRepository {
  constructor(repository) {
    this.repository = repository;
    this.db = repository.db;
  }

  async transaction(operation) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async start(id, configuration, caseIds, repetitions) {
    return this.transaction(async client => {
      const slot = await client.query(`INSERT INTO golden_standard_suites(suite_id,state,configuration)
        VALUES($1,'running',$2) ON CONFLICT DO NOTHING RETURNING suite_id`, [id, configuration]);
      if (!slot.rowCount) return false;
      const queue = Array.from({ length: repetitions }, () => caseIds).flat();
      await client.query(`INSERT INTO golden_standard_attempts(suite_id,ordinal,case_id,repetition)
        SELECT $1, pos-1, case_id, 1 + (pos-1)/$3::int FROM unnest($2::text[]) WITH ORDINALITY AS queue(case_id,pos)`,
      [id, queue, caseIds.length]);
      return true;
    });
  }

  async read(id) {
    const suite = (await this.db.query('SELECT * FROM golden_standard_suites WHERE suite_id=$1', [id])).rows[0];
    if (!suite) return null;
    const attempts = (await this.db.query(`${selectAttempt} WHERE a.suite_id=$1 ORDER BY a.ordinal`, [id])).rows;
    return { ...suite, attempts };
  }

  async history() {
    const suites = (await this.db.query(`SELECT suite_id FROM golden_standard_suites
      ORDER BY (state='running') DESC, created_at DESC LIMIT 30`)).rows;
    return (await Promise.all(suites.map(({ suite_id }) => this.read(suite_id)))).filter(Boolean);
  }

  async next(id, routingHash, build) {
    return this.transaction(async client => {
      const suite = (await client.query('SELECT * FROM golden_standard_suites WHERE suite_id=$1 FOR UPDATE', [id])).rows[0];
      if (suite?.state !== 'running' || suite.configuration.routingHash !== routingHash
        || suite.configuration.build !== build) return null;
      // Never run two attempts concurrently; skip completed ('delivered') and recorded failed ('incomplete') attempts.
      const next = (await client.query(`SELECT * FROM golden_standard_attempts
        WHERE suite_id=$1 AND state IN ('running','queued')
        ORDER BY (state='running') DESC, ordinal LIMIT 1`, [id])).rows[0];
      if (!next || next.state !== 'queued') return null;
      const run = await this.repository.createRun(client);
      return (await client.query(`UPDATE golden_standard_attempts
        SET state='running',run_id=$3,started_at=clock_timestamp()
        WHERE suite_id=$1 AND ordinal=$2 RETURNING *`, [id, next.ordinal, run.run_id])).rows[0];
    });
  }

  async finish(id, ordinal, runId, comparison, summary = null) {
    return this.transaction(async client => {
      const suite = (await client.query('SELECT state FROM golden_standard_suites WHERE suite_id=$1 FOR UPDATE', [id])).rows[0];
      if (!suite) return false;
      const existing = (await client.query(`SELECT state, (comparison - 'usage') = $4::jsonb AS same_comparison
        FROM golden_standard_attempts WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3`,
      [id, ordinal, runId, comparison])).rows[0];
      if (existing?.state === 'delivered') {
        if (existing.same_comparison && summary !== null) {
          await client.query(`UPDATE golden_standard_attempts SET summary=COALESCE(summary,$4)
            WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3`, [id, ordinal, runId, summary]);
        }
        return existing.same_comparison;
      }
      if (suite.state !== 'running' || existing?.state !== 'running') return false;
      const usage = (await client.query(`SELECT count(*)::int AS calls,
        CASE WHEN count(input_tokens)=count(*) THEN sum(input_tokens)::int END AS input_tokens,
        CASE WHEN count(output_tokens)=count(*) THEN sum(output_tokens)::int END AS output_tokens,
        COALESCE(array_agg(DISTINCT stage || ':' || provider || '/' || model ORDER BY stage || ':' || provider || '/' || model),'{}') AS models
        FROM model_attempts WHERE run_id=$1 AND send_authorized_at IS NOT NULL`, [runId])).rows[0];
      const delivered = await client.query(`UPDATE golden_standard_attempts a
        SET state='delivered',finished_at=clock_timestamp(),comparison=$4,summary=$5,failure=NULL FROM runs r
        WHERE a.suite_id=$1 AND a.ordinal=$2 AND a.run_id=$3 AND r.run_id=a.run_id
        AND r.state='completed' AND r.cleanup_status='verified'`, [id, ordinal, runId, { ...comparison, usage }, summary]);
      if (!delivered.rowCount) return false;
      await client.query(`UPDATE golden_standard_suites SET state='completed',finished_at=clock_timestamp()
        WHERE suite_id=$1 AND NOT EXISTS (SELECT 1 FROM golden_standard_attempts WHERE suite_id=$1 AND state IN ('queued','running'))`, [id]);
      return true;
    });
  }

  async fail(id, ordinal, runId, failure) {
    return this.transaction(async client => {
      const suite = (await client.query('SELECT state FROM golden_standard_suites WHERE suite_id=$1 FOR UPDATE', [id])).rows[0];
      if (!suite) return { recorded: false, cleanupRunIds: [] };
      const existing = (await client.query(`SELECT state FROM golden_standard_attempts
        WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3`, [id, ordinal, runId])).rows[0];
      if (!existing || existing.state === 'delivered') return { recorded: false, cleanupRunIds: [] };
      if (existing.state === 'running') {
        await client.query(`UPDATE golden_standard_attempts
          SET state='incomplete',finished_at=clock_timestamp(),failure=$4
          WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3`, [id, ordinal, runId, failure]);
      } else if (failure) {
        await client.query(`UPDATE golden_standard_attempts SET failure=COALESCE(failure,$4)
          WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3`, [id, ordinal, runId, failure]);
      }
      await client.query(`UPDATE runs SET state=CASE WHEN state IN ('active','recovery_required','ready_for_delivery','completed')
          THEN 'deletion_requested' ELSE state END,
        terminal_at=COALESCE(terminal_at,clock_timestamp()),
        cleanup_status=COALESCE(cleanup_status,'pending'),
        failure_code=COALESCE(failure_code,$2)
        WHERE run_id=$1 AND cleanup_status IS DISTINCT FROM 'verified'`, [runId, failure?.code ?? 'GOLDEN_STANDARD_INCOMPLETE']);
      if (suite.state === 'running') {
        await client.query(`UPDATE golden_standard_suites SET state='completed',finished_at=clock_timestamp()
          WHERE suite_id=$1 AND NOT EXISTS (SELECT 1 FROM golden_standard_attempts WHERE suite_id=$1 AND state IN ('queued','running'))`, [id]);
      }
      const pending = await client.query(`SELECT run_id FROM runs WHERE run_id=$1 AND cleanup_status IS DISTINCT FROM 'verified'`, [runId]);
      return { recorded: true, cleanupRunIds: pending.rows.map(row => row.run_id) };
    });
  }

  async cancel(id) {
    return this.transaction(async client => {
      const suite = (await client.query('SELECT state FROM golden_standard_suites WHERE suite_id=$1 FOR UPDATE', [id])).rows[0];
      if (!suite || suite.state === 'completed') return [];
      const cancelled = await client.query(`UPDATE golden_standard_attempts SET state='incomplete',finished_at=clock_timestamp()
        WHERE suite_id=$1 AND state='running' RETURNING run_id`, [id]);
      const ids = cancelled.rows.map(row => row.run_id);
      // Fence further dispatch before releasing the suite lock. The existing cleanup worker
      // can also finish cleanup if the browser or this request disconnects.
      await client.query(`UPDATE runs SET state='deletion_requested',terminal_at=COALESCE(terminal_at,clock_timestamp()),
        cleanup_status=COALESCE(cleanup_status,'pending')
        WHERE run_id=ANY($1::uuid[]) AND state IN ('active','recovery_required','ready_for_delivery','completed')
        AND cleanup_status IS DISTINCT FROM 'verified'`, [ids]);
      await client.query(`UPDATE golden_standard_suites SET state='cancelled',finished_at=COALESCE(finished_at,clock_timestamp())
        WHERE suite_id=$1`, [id]);
      const pending = await client.query(`SELECT r.run_id FROM golden_standard_attempts a JOIN runs r USING(run_id)
        WHERE a.suite_id=$1 AND a.state='incomplete' AND r.cleanup_status IS DISTINCT FROM 'verified'
        ORDER BY a.ordinal`, [id]);
      return pending.rows.map(row => row.run_id);
    });
  }

  async review(id, ordinal, runId, referenceSha256, dispositions) {
    const result = await this.db.query(`UPDATE golden_standard_attempts
      SET review=jsonb_build_object('dispositions',$5::jsonb,'reviewedAt',clock_timestamp())
      WHERE suite_id=$1 AND ordinal=$2 AND run_id=$3 AND state='delivered' AND comparison->>'referenceSha256'=$4`,
    [id, ordinal, runId, referenceSha256, dispositions]);
    return !!result.rowCount;
  }
}
