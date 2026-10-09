# Idempotent payment instructions

A TypeScript function that records a payment instruction in PostgreSQL so that a retried
request can never create it twice, plus integration tests that prove it, including two
requests arriving at the same moment.

## Design

`recordPaymentInstruction(db, input)` in [`src/payment-instructions.ts`](src/payment-instructions.ts)

- The caller supplies an **idempotency key** with each request and reuses it on retries.
- `payment_instructions.idempotency_key` has a **`UNIQUE` constraint**
  ([`migrations/001_create_payment_instructions.sql`](migrations/001_create_payment_instructions.sql)).
  This is the guarantee; the TypeScript code does not try to enforce uniqueness itself.
- The function runs one atomic statement:

  ```sql
  INSERT INTO payment_instructions (...) VALUES (...)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING ...
  ```

  If a row comes back, this call created it (`created: true`). If not, the key already
  exists and the function reads that row.
- **Retry with the same details:** returns the original instruction (`created: false`).
- **Same key, different amount, currency or recipient:** throws `IdempotencyConflictError`
  instead of silently returning a payment the caller did not ask for.
- Amounts are integer minor units, held as `bigint` in TypeScript and `bigint` in
  PostgreSQL, so there is no floating point and values above 2^53 stay exact.

## Why it is safe under concurrency

The obvious approach, `SELECT` to see whether the key exists and then `INSERT` if it does
not, is deliberately avoided. Two requests can both run the `SELECT`, both see nothing,
and both insert.

Here the check and the write are one operation on the unique index, inside PostgreSQL:

- If two transactions insert the same key at once, the second one finds the first one's
  uncommitted entry in the index and **waits** for that transaction to finish. If it
  commits, the second `INSERT` does nothing. If it rolls back, the second one inserts.
  At most one row can ever be committed.
- After a conflict, the follow-up `SELECT` is a new statement, so under `READ COMMITTED`
  (PostgreSQL's default) it sees the winning row, which is already committed by then.
- No state or locks live in the application, so this holds across any number of
  connections, processes and hosts.

Call the function outside a transaction or in a `READ COMMITTED` one. Under
`REPEATABLE READ` or `SERIALIZABLE`, a concurrent conflict is reported as a serialization
error for the caller to retry; that still never creates a duplicate.

## Running it

Requires Node.js 24.2+ and Docker.

```sh
npm ci                     # install dependencies
cp .env.example .env       # PowerShell: Copy-Item .env.example .env
npm run db:up              # start PostgreSQL 17 in Docker and wait until it is healthy
npm test                   # apply migrations, then run the integration tests
npm run typecheck          # tsc in strict mode, type-check only (no build output)
npm run db:down            # stop PostgreSQL and delete its data
```

`.env` holds `DATABASE_URL`, which matches the Docker Compose credentials. If port 5432 is
already in use, start the database with `POSTGRES_PORT=5433 npm run db:up` and change
the port in `.env` to match.

`npm run migrate` applies migrations by hand; the test run does this automatically.

## Tests

[`test/payment-instructions.test.ts`](test/payment-instructions.test.ts) runs against the
real PostgreSQL. Nothing is mocked, and the table is truncated before each test.

- **Create:** one call creates one row, and the returned values match what was stored.
- **Sequential retry:** returns the same instruction ID, and exactly one row exists.
- **Concurrent duplicate:** two calls on **two independent PostgreSQL connections**
  (different server process IDs, checked in the test), started together with
  `Promise.all`. Both resolve to the same instruction, exactly one reports `created`, and
  a direct query confirms **exactly one row** for the key.
- **Forced overlap:** a second concurrency test makes the timing deterministic without
  sleeps. Connection A inserts inside an open transaction. Connection B's identical call is
  then started, and the test waits until PostgreSQL reports (`pg_blocking_pids`) that B is
  blocked on A. Only then does A commit. B must return A's row, and one row exists.
- **Conflicting retry:** the same key with a different amount, currency or recipient
  throws `IdempotencyConflictError`, and the original row is unchanged.
- **Large amounts:** an amount above `Number.MAX_SAFE_INTEGER` round-trips exactly.

## Scope

Deliberately kept small:

- No HTTP layer, framework or ORM. This is just the function, the schema and the tests.
- Input validation is left to the database `CHECK` constraints: a positive amount, an
  upper-case three-letter currency, and a non-blank recipient and key.
- Idempotency keys never expire, and a payment instruction has no status or lifecycle.
- Payment details are compared exactly, with no normalisation (for example of the
  recipient's case or whitespace).
- `npm test` truncates `payment_instructions` in the database that `DATABASE_URL` points
  at. It is meant for the local Docker database.
