import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './db.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary constant: serialises concurrent migration runners (e.g. two test runs).
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies every `migrations/*.sql` file not yet recorded in `schema_migrations`,
 * in lexical filename order, each inside its own transaction.
 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    // Session-level lock, held on this one connection for the whole run.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        // Don't let a failing ROLLBACK (e.g. dead connection) mask the original error.
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed`, { cause: err });
      }
      newlyApplied.push(file);
    }

    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    return newlyApplied;
  } catch (err) {
    // Discard the connection rather than return it to the pool in an unknown state
    // (this also drops the advisory lock).
    broken = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    client.release(broken);
  }
}

if (import.meta.main) {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  } finally {
    await pool.end();
  }
}
