import { walletRepo } from '@/repositories/walletRepo';
import { ledgerRepo } from '@/repositories/ledgerRepo';
import { InsufficientFundsError } from '@/services/economy/errors';
import type { Tx } from '@/lib/db';

export interface CurrencyOp {
  playerId: string;
  currencyCode: string;
  amount: number; // always positive; direction implied by credit/debit
  reason: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}

/** Credit currency: bump the wallet and append a +delta ledger row, atomically. */
export const creditCurrency = async (tx: Tx, op: CurrencyOp): Promise<number> => {
  const balanceAfter = await walletRepo.applyDelta(tx, op.playerId, op.currencyCode, op.amount);
  await ledgerRepo.append(tx, {
    playerId: op.playerId,
    currencyCode: op.currencyCode,
    delta: op.amount,
    reason: op.reason,
    balanceAfter,
    refType: op.refType,
    refId: op.refId,
    idempotencyKey: op.idempotencyKey,
  });
  return balanceAfter;
};

/**
 * Debit currency: assert sufficient balance, decrement, append a -delta ledger row.
 * The DB CHECK(balance >= 0) is the final guard; this raises a typed error first.
 */
export const debitCurrency = async (tx: Tx, op: CurrencyOp): Promise<number> => {
  const have = await walletRepo.getBalance(tx, op.playerId, op.currencyCode);
  if (have < op.amount) throw new InsufficientFundsError(op.currencyCode, op.amount, have);

  const balanceAfter = await walletRepo.applyDelta(tx, op.playerId, op.currencyCode, -op.amount);
  await ledgerRepo.append(tx, {
    playerId: op.playerId,
    currencyCode: op.currencyCode,
    delta: -op.amount,
    reason: op.reason,
    balanceAfter,
    refType: op.refType,
    refId: op.refId,
    idempotencyKey: op.idempotencyKey,
  });
  return balanceAfter;
};
