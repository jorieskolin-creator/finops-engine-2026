export const migrationVersion = name => {
  const match = /^(\d+)_/.exec(name);
  if (!match) throw new Error('INVALID_MIGRATION_FILENAME');
  return Number(match[1]);
};

export const pendingMigrations = (migrations, appliedVersions) => migrations
  .filter(name => !appliedVersions.has(migrationVersion(name)));
