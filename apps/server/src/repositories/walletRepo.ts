import { and, eq, sql } from 'drizzle-orm';
import { playerWallets } from '@shared/schema';
import type { Tx } from '@/lib/db';

/** Typed wallet data access. No business logic — services compose these in a txn. */
export const walletRepo = {
  /** Current balance for a currency, or 0 if the wallet row doesn't exist yet. */
  async getBalance(tx: Tx, playerId: string, currencyCode: string): Promise<number> {
    const [row] = await tx
      .select({ balance: playerWallets.balance })
      .from(playerWallets)
      .where(
        and(eq(playerWallets.playerId, playerId), eq(playerWallets.currencyCode, currencyCode)),
      );
    return row?.balance ?? 0;
  },

  /**
   * Apply a delta to a wallet, upserting the row. Returns the new balance.
   * The DB CHECK(balance >= 0) is the last line of defense against oversell.
   *
   * Update-first (not a single ON CONFLICT upsert) on purpose: Postgres evaluates
   * CHECK constraints on the candidate INSERT tuple, so a negative delta would trip
   * CHECK(balance >= 0) even when the row exists and the op resolves to an UPDATE.
   */
  async applyDelta(
    tx: Tx,
    playerId: string,
    currencyCode: string,
    delta: number,
  ): Promise<number> {
    const updated = await tx
      .update(playerWallets)
      .set({ balance: sql`${playerWallets.balance} + ${delta}` })
      .where(
        and(eq(playerWallets.playerId, playerId), eq(playerWallets.currencyCode, currencyCode)),
      )
      .returning({ balance: playerWallets.balance });
    if (updated[0]) return updated[0].balance;

    // No wallet yet — insert. Debits are pre-checked, so delta is non-negative here.
    // ON CONFLICT guards a concurrent insert of the same wallet.
    const [row] = await tx
      .insert(playerWallets)
      .values({ playerId, currencyCode, balance: delta })
      .onConflictDoUpdate({
        target: [playerWallets.playerId, playerWallets.currencyCode],
        set: { balance: sql`${playerWallets.balance} + ${delta}` },
      })
      .returning({ balance: playerWallets.balance });
    return row!.balance;
  },
};
