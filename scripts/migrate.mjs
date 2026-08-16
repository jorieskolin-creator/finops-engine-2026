import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { migrationVersion, pendingMigrations } from './migration-plan.mjs';
if (!process.env.DATABASE_URL) { console.error('MIGRATION_DATABASE_URL_REQUIRED'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationsUrl))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (migrations.length === 0 || migrationVersion(migrations[0]) !== 1) throw new Error('INITIAL_MIGRATION_REQUIRED');

  // Migration 001 bootstraps schema_versions and is idempotent. Once that
  // registry exists, never replay an applied historical migration: a former
  // constraint can be incompatible with data admitted by a later version.
  await pool.query(await readFile(new URL(migrations[0], migrationsUrl), 'utf8'));
  const applied = new Set((await pool.query('SELECT version FROM schema_versions')).rows.map(row => Number(row.version)));
  for (const migration of pendingMigrations(migrations.slice(1), applied)) {
    await pool.query(await readFile(new URL(migration, migrationsUrl), 'utf8'));
    await pool.query('INSERT INTO schema_versions(version) VALUES ($1) ON CONFLICT DO NOTHING', [migrationVersion(migration)]);
  }
  console.log('MIGRATION_COMPLETE');
} catch { console.error('MIGRATION_FAILED'); process.exitCode = 1; }
finally { await pool.end().catch(() => {}); }
