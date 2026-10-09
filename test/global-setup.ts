import { createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

// Runs once before the whole test run: bring the real database schema up to date.
export async function setup(): Promise<void> {
  const pool = createPool();
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
