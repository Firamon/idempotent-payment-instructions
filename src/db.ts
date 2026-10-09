import pg from 'pg';

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
  }
  return url;
}

export function createPool(connectionString: string = databaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString });
}
