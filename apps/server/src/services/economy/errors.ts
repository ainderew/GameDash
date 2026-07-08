/** Typed economy errors so controllers can map them to HTTP codes cleanly. */

export class InsufficientFundsError extends Error {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(
    readonly currencyCode: string,
    readonly needed: number,
    readonly have: number,
  ) {
    super(`Insufficient ${currencyCode}: need ${needed}, have ${have}`);
    this.name = 'InsufficientFundsError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly key: string) {
    super(`Idempotency key reused with a different request body: ${key}`);
    this.name = 'IdempotencyConflictError';
  }
}
