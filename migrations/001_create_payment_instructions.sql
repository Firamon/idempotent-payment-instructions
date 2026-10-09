-- A payment instruction recorded at most once per idempotency key.
--
-- The UNIQUE constraint on idempotency_key is the idempotency guarantee: it is
-- enforced by PostgreSQL's unique index, so it holds across concurrent
-- transactions and across any number of application processes.

CREATE TABLE payment_instructions (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    idempotency_key text        NOT NULL,
    amount_minor    bigint      NOT NULL,
    currency        text        NOT NULL,
    recipient       text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT payment_instructions_pkey
        PRIMARY KEY (id),
    CONSTRAINT payment_instructions_idempotency_key_key
        UNIQUE (idempotency_key),

    CONSTRAINT payment_instructions_idempotency_key_check
        CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    -- Integer minor units (e.g. cents): no floating point anywhere.
    CONSTRAINT payment_instructions_amount_minor_check
        CHECK (amount_minor > 0),
    -- ISO 4217 alphabetic code, upper case.
    CONSTRAINT payment_instructions_currency_check
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT payment_instructions_recipient_check
        CHECK (char_length(btrim(recipient)) > 0)
);
