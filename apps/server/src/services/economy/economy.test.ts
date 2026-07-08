import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { players, playerWallets, currencyLedger, idempotencyKeys } from '@shared/schema';
import { runEconomyTx } from '@/services/economy/runEconomyTx';
import { creditCurrency, debitCurrency } from '@/services/economy/currencyOps';
import { IdempotencyConflictError, InsufficientFundsError } from '@/services/economy/errors';

/**
 * Integration test against the real Supabase Postgres. Creates an isolated temp
 * player and deletes all its rows afterward, so it leaves no trace.
 */
const db = getDb();
const userId = crypto.randomUUID();
let playerId: string;

const balanceOf = async (code: string) => {
  const [row] = await db
    .select({ b: playerWallets.balance })
    .from(playerWallets)
    .where(and(eq(playerWallets.playerId, playerId), eq(playerWallets.currencyCode, code)));
  return row?.b ?? 0;
};

beforeAll(async () => {
  const [p] = await db
    .insert(players)
    .values({ authUserId: userId, displayName: 'test-hunter' })
    .returning({ id: players.id });
  playerId = p!.id;
});

afterAll(async () => {
  await db.delete(currencyLedger).where(eq(currencyLedger.playerId, playerId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
  await db.delete(players).where(eq(players.id, playerId)); // cascades wallets
});

describe('economy primitive (real DB)', () => {
  it('credits currency and writes a ledger row', async () => {
    const res = await runEconomyTx(
      { userId, idempotencyKey: 'k-credit', requestHash: 'h1' },
      async (tx) => ({ balance: await creditCurrency(tx, credit(50)) }),
    );
    expect(res.balance).toBe(50);
    expect(await balanceOf('common')).toBe(50);
  });

  it('is idempotent — replaying the same key does not double-credit', async () => {
    const again = await runEconomyTx(
      { userId, idempotencyKey: 'k-credit', requestHash: 'h1' },
      async (tx) => ({ balance: await creditCurrency(tx, credit(50)) }),
    );
    expect(again.balance).toBe(50); // cached response
    expect(await balanceOf('common')).toBe(50); // still 50, not 100
  });

  it('rejects the same key with a different body (409-style)', async () => {
    await expect(
      runEconomyTx({ userId, idempotencyKey: 'k-credit', requestHash: 'DIFFERENT' }, async (tx) => ({
        balance: await creditCurrency(tx, credit(50)),
      })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('debits and keeps ledger sum equal to the wallet balance', async () => {
    const res = await runEconomyTx(
      { userId, idempotencyKey: 'k-debit', requestHash: 'h2' },
      async (tx) => ({ balance: await debitCurrency(tx, debit(30)) }),
    );
    expect(res.balance).toBe(20);

    const rows = await db
      .select({ total: sql<number>`coalesce(sum(${currencyLedger.delta}), 0)::int` })
      .from(currencyLedger)
      .where(and(eq(currencyLedger.playerId, playerId), eq(currencyLedger.currencyCode, 'common')));
    expect(rows[0]?.total ?? 0).toBe(await balanceOf('common'));
  });

  it('rejects an oversell and writes no ledger row for it', async () => {
    const before = await ledgerCount();
    await expect(
      runEconomyTx({ userId, idempotencyKey: 'k-oversell', requestHash: 'h3' }, async (tx) => ({
        balance: await debitCurrency(tx, debit(9999)),
      })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balanceOf('common')).toBe(20); // unchanged
    expect(await ledgerCount()).toBe(before); // no new ledger row (txn rolled back)
  });
});

const credit = (amount: number) => ({
  playerId,
  currencyCode: 'common',
  amount,
  reason: 'test-credit',
  idempotencyKey: 'k-credit',
});
const debit = (amount: number) => ({
  playerId,
  currencyCode: 'common',
  amount,
  reason: 'test-debit',
});
const ledgerCount = async () => {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(currencyLedger)
    .where(eq(currencyLedger.playerId, playerId));
  return rows[0]?.c ?? 0;
};
