import type pg from 'pg';

/** Anything that can run a query: a pool, or one dedicated connection (pool client or client). */
export type Db = pg.Pool | pg.ClientBase;

export interface PaymentInstructionInput {
  idempotencyKey: string;
  /** Integer minor units (e.g. cents). bigint so values beyond 2^53 stay exact. */
  amountMinor: bigint;
  currency: string;
  recipient: string;
}

export interface PaymentInstruction extends PaymentInstructionInput {
  id: string;
  createdAt: Date;
}

export interface RecordResult {
  instruction: PaymentInstruction;
  /** true if this call inserted the row; false if it already existed (a retry). */
  created: boolean;
}

/** The idempotency key was already used for a payment instruction with different details. */
export class IdempotencyKeyReuseError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with different payment details`);
    this.name = 'IdempotencyKeyReuseError';
    this.idempotencyKey = idempotencyKey;
  }
}

interface Row {
  id: string;
  idempotency_key: string;
  amount_minor: string; // node-postgres returns int8 as a string; converted to bigint below
  currency: string;
  recipient: string;
  created_at: Date;
}

const COLUMNS = 'id, idempotency_key, amount_minor, currency, recipient, created_at';

/**
 * Records a payment instruction at most once per idempotency key.
 *
 * Uniqueness is enforced by the UNIQUE constraint on payment_instructions.idempotency_key,
 * so this is safe across concurrent connections and processes. Run it in autocommit mode
 * or a READ COMMITTED transaction (PostgreSQL's default).
 */
export async function recordPaymentInstruction(
  db: Db,
  input: PaymentInstructionInput,
): Promise<RecordResult> {
  const { idempotencyKey, amountMinor, currency, recipient } = input;

  // Atomic insert-or-skip. If another transaction holds an uncommitted row with the same key,
  // PostgreSQL blocks here until it commits (-> we skip) or rolls back (-> we insert).
  const inserted = await db.query<Row>(
    `INSERT INTO payment_instructions (idempotency_key, amount_minor, currency, recipient)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [idempotencyKey, amountMinor.toString(), currency, recipient],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return { instruction: toInstruction(insertedRow), created: true };
  }

  // Conflict: the winning row is committed. A new statement takes a new snapshot, so it sees it.
  const existing = await db.query<Row>(
    `SELECT ${COLUMNS} FROM payment_instructions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error(`Payment instruction for idempotency key "${idempotencyKey}" not found after conflict`);
  }

  const instruction = toInstruction(existingRow);
  if (
    instruction.amountMinor !== amountMinor ||
    instruction.currency !== currency ||
    instruction.recipient !== recipient
  ) {
    throw new IdempotencyKeyReuseError(idempotencyKey);
  }
  return { instruction, created: false };
}

function toInstruction(row: Row): PaymentInstruction {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    recipient: row.recipient,
    createdAt: row.created_at,
  };
}
