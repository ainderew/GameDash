import { currencyLedger } from '@shared/schema';
import type { Tx } from '@/lib/db';

export interface LedgerRow {
  playerId: string;
  currencyCode: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}

/** Append-only currency ledger. Every balance change writes exactly one row here. */
export const ledgerRepo = {
  async append(tx: Tx, row: LedgerRow): Promise<void> {
    await tx.insert(currencyLedger).values({
      playerId: row.playerId,
      currencyCode: row.currencyCode,
      delta: row.delta,
      reason: row.reason,
      balanceAfter: row.balanceAfter,
      refType: row.refType,
      refId: row.refId,
      idempotencyKey: row.idempotencyKey,
    });
  },
};
