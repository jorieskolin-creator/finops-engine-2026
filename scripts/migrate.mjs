import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) { console.error('MIGRATION_DATABASE_URL_REQUIRED'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await pool.query(await readFile(new URL('../migrations/001_control_plane.sql', import.meta.url), 'utf8'));
  console.log('MIGRATION_COMPLETE');
} catch { console.error('MIGRATION_FAILED'); process.exitCode = 1; }
finally { await pool.end().catch(() => {}); }
