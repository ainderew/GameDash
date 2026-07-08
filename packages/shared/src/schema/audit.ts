import {
  pgTable,
  text,
  bigint,
  bigserial,
  integer,
  jsonb,
  uuid,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Audit / integrity tables. The currency ledger is append-only and is the true
 * source of currency (wallets are a materialized convenience). Idempotency keys
 * make every mutating economy request exactly-once.
 */

export const currencyLedger = pgTable(
  'currency_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    playerId: uuid('player_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(), // 'drop' | 'upgrade' | 'gacha' | 'admin' | ...
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key'),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('ledger_player_created_idx').on(t.playerId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseCode: integer('response_code'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('idempotency_user_key').on(t.userId, t.key)],
);
