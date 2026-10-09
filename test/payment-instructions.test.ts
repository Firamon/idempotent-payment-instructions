import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, databaseUrl } from '../src/db.ts';
import {
  IdempotencyConflictError,
  recordPaymentInstruction,
  type PaymentInstructionInput,
} from '../src/payment-instructions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A row as stored, read independently of the code under test (int8 arrives as a string). */
interface StoredRow {
  id: string;
  idempotency_key: string;
  amount_minor: string;
  currency: string;
  recipient: string;
  created_at: Date;
}

const payment: PaymentInstructionInput = {
  idempotencyKey: 'payment-123',
  amountMinor: 10_000n,
  currency: 'GBP',
  recipient: 'alice',
};

describe('recordPaymentInstruction (real PostgreSQL)', () => {
  // `pool` is used for setup and for inspecting the table independently of the code under test.
  let pool: pg.Pool;
  // Dedicated connections opened by a test; closed after each test.
  let clients: pg.Client[] = [];

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: databaseUrl() });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function backendPid(client: pg.Client): Promise<number> {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return rows[0]!.pid;
  }

  async function rowsFor(idempotencyKey: string): Promise<StoredRow[]> {
    const { rows } = await pool.query<StoredRow>(
      'SELECT * FROM payment_instructions WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return rows;
  }

  beforeAll(() => {
    pool = createPool();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE payment_instructions');
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end()));
    clients = [];
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates one payment instruction and returns its stored values', async () => {
    const result = await recordPaymentInstruction(pool, payment);

    expect(result.created).toBe(true);
    expect(result.instruction).toEqual({
      id: expect.stringMatching(UUID),
      idempotencyKey: 'payment-123',
      amountMinor: 10_000n,
      currency: 'GBP',
      recipient: 'alice',
      createdAt: expect.any(Date),
    });

    const rows = await rowsFor('payment-123');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.instruction.id,
      amount_minor: '10000',
      currency: 'GBP',
      recipient: 'alice',
    });
  });

  it('keeps amounts beyond Number.MAX_SAFE_INTEGER exact', async () => {
    const amountMinor = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a JS number

    const { instruction } = await recordPaymentInstruction(pool, { ...payment, amountMinor });

    expect(instruction.amountMinor).toBe(amountMinor);
    expect((await rowsFor('payment-123'))[0]?.amount_minor).toBe('9007199254740993');
  });

  it('returns the existing instruction when the same request is retried sequentially', async () => {
    const first = await recordPaymentInstruction(pool, payment);
    const retry = await recordPaymentInstruction(pool, { ...payment });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.instruction).toEqual(first.instruction);
    expect(await rowsFor('payment-123')).toHaveLength(1);
  });

  it('creates exactly one row when two identical requests arrive at the same moment', async () => {
    const [connA, connB] = await Promise.all([connect(), connect()]);
    // Two distinct server backends: nothing is serialised through a shared client.
    expect(await backendPid(connA)).not.toBe(await backendPid(connB));

    const [a, b] = await Promise.all([
      recordPaymentInstruction(connA, payment),
      recordPaymentInstruction(connB, payment),
    ]);

    expect(a.instruction.id).toBe(b.instruction.id);
    expect(a.instruction).toEqual(b.instruction);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await rowsFor('payment-123')).toHaveLength(1);
  });

  it('makes a concurrent duplicate wait for the in-flight insert, then return that row', async () => {
    // Forces the worst-case interleaving deterministically, without sleeps:
    // A has inserted but not committed when B arrives.
    const [connA, connB] = await Promise.all([connect(), connect()]);
    const pidA = await backendPid(connA);
    const pidB = await backendPid(connB);

    await connA.query('BEGIN');
    const a = await recordPaymentInstruction(connA, payment); // row inserted, still uncommitted

    const [bResult] = await Promise.all([
      recordPaymentInstruction(connB, payment), // must block on A's uncommitted key
      // Commit A only once PostgreSQL itself reports that B is blocked by A.
      waitUntilBlocked(pidB, pidA).then(() => connA.query('COMMIT')),
    ]);

    expect(a.created).toBe(true);
    expect(bResult.created).toBe(false);
    expect(bResult.instruction).toEqual(a.instruction);
    expect(await rowsFor('payment-123')).toHaveLength(1);
  });

  it('rejects a retry that reuses the key with different payment details', async () => {
    await recordPaymentInstruction(pool, payment);
    const before = await rowsFor('payment-123');

    const attempt = recordPaymentInstruction(pool, { ...payment, amountMinor: 50_000n });

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(attempt).rejects.toMatchObject({
      idempotencyKey: 'payment-123',
      existing: { amountMinor: 10_000n },
    });
    const after = await rowsFor('payment-123');
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it.each([
    ['currency', { currency: 'EUR' }],
    ['recipient', { recipient: 'bob' }],
  ])('treats a different %s under the same key as a conflict', async (_field, change) => {
    await recordPaymentInstruction(pool, payment);

    await expect(recordPaymentInstruction(pool, { ...payment, ...change })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await rowsFor('payment-123')).toHaveLength(1);
  });

  it('creates a separate instruction for a new idempotency key', async () => {
    const first = await recordPaymentInstruction(pool, payment);
    const second = await recordPaymentInstruction(pool, { ...payment, idempotencyKey: 'payment-124' });

    expect(second.created).toBe(true);
    expect(second.instruction.id).not.toBe(first.instruction.id);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_instructions');
    expect(rows[0]?.n).toBe(2);
  });

  /**
   * Polls PostgreSQL's lock graph until `waitingPid` is blocked by `blockingPid`.
   * The deadline only turns a regression (B never blocks) into a clear failure instead of a hang.
   */
  async function waitUntilBlocked(waitingPid: number, blockingPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ blocked: boolean }>(
        'SELECT $2::int = ANY (pg_blocking_pids($1)) AS blocked',
        [waitingPid, blockingPid],
      );
      if (rows[0]!.blocked) return;
    }
    throw new Error(`backend ${waitingPid} was never blocked by backend ${blockingPid}`);
  }
});
