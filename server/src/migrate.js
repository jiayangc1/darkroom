import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, tx } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    await tx(async (c) => {
      // Serialize concurrent boots.
      await c.query('SELECT pg_advisory_xact_lock(4241)');
      const { rowCount } = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (rowCount) return;
      await c.query(await readFile(path.join(dir, name), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      console.log(`[migrate] applied ${name}`);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
