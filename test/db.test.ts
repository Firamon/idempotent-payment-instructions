import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.ts';

// Smoke test for the scaffold: proves the suite reaches a real Postgres and migrations ran.
describe('database connectivity', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('connects to Postgres', async () => {
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
  });

  it('has the migrations bookkeeping table', async () => {
    const { rows } = await pool.query<{ table: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS table",
    );
    expect(rows[0]?.table).toBe('schema_migrations');
  });
});
