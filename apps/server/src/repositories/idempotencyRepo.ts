import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from '@shared/schema';
import type { Tx } from '@/lib/db';

export interface IdempotencyRecord {
  requestHash: string;
  responseCode: number | null;
  responseBody: Record<string, unknown> | null;
}

/**
 * Idempotency bookkeeping. `claim` reserves a key for a request; if the key
 * already exists it returns the stored record so the service can replay the
 * cached response (exactly-once semantics over an at-least-once network).
 */
export const idempotencyRepo = {
  async find(tx: Tx, userId: string, key: string): Promise<IdempotencyRecord | null> {
    const [row] = await tx
      .select({
        requestHash: idempotencyKeys.requestHash,
        responseCode: idempotencyKeys.responseCode,
        responseBody: idempotencyKeys.responseBody,
      })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    return row ?? null;
  },

  /** Insert the claim row (locked). Throws on unique conflict if already claimed. */
  async claim(tx: Tx, userId: string, key: string, requestHash: string): Promise<void> {
    await tx.insert(idempotencyKeys).values({
      userId,
      key,
      requestHash,
      lockedAt: new Date(),
    });
  },

  async complete(
    tx: Tx,
    userId: string,
    key: string,
    responseCode: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await tx
      .update(idempotencyKeys)
      .set({ responseCode, responseBody })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
  },
};
