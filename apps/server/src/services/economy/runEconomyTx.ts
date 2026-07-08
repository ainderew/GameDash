import { getDb } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { idempotencyRepo } from '@/repositories/idempotencyRepo';
import { IdempotencyConflictError } from '@/services/economy/errors';

export interface EconomyTxContext {
  /** The authenticated user (from the session — never the request body). */
  userId: string;
  /** Client-generated idempotency key for this mutation. */
  idempotencyKey: string;
  /** Stable hash of the request body, to detect key reuse with a different payload. */
  requestHash: string;
}

/**
 * The invariant every economy mutation follows:
 *   serializable transaction + idempotency claim + append-only ledger.
 *
 * - If the key was already completed with the same body → returns the cached response.
 * - If the key was used with a different body → throws IdempotencyConflictError.
 * - Otherwise runs `fn(tx)`, caches its JSON response, and commits.
 *
 * A retried request is therefore exactly-once: no double-grant, no double-charge.
 */
export const runEconomyTx = async <T extends Record<string, unknown>>(
  ctx: EconomyTxContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  const db = getDb();
  return db.transaction(
    async (tx) => {
      const existing = await idempotencyRepo.find(tx, ctx.userId, ctx.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== ctx.requestHash) {
          throw new IdempotencyConflictError(ctx.idempotencyKey);
        }
        if (existing.responseBody) return existing.responseBody as T;
        // Claimed but not yet completed (in-flight/crashed): safest is to treat as conflict.
        throw new IdempotencyConflictError(ctx.idempotencyKey);
      }

      await idempotencyRepo.claim(tx, ctx.userId, ctx.idempotencyKey, ctx.requestHash);
      const result = await fn(tx);
      await idempotencyRepo.complete(tx, ctx.userId, ctx.idempotencyKey, 200, result);
      return result;
    },
    { isolationLevel: 'serializable' },
  );
};
