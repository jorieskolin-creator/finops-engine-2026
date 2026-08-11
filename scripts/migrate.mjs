import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) { console.error('MIGRATION_DATABASE_URL_REQUIRED'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationsUrl))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(new URL(migration, migrationsUrl), 'utf8'));
  }
  console.log('MIGRATION_COMPLETE');
} catch { console.error('MIGRATION_FAILED'); process.exitCode = 1; }
finally { await pool.end().catch(() => {}); }
