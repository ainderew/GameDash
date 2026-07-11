/**
 * `@friendslop/shared/net` — protocol v1: message schemas/types, tuning constants,
 * identity helpers. Imported by apps/realtime (validation) and apps/web (types).
 * Deliberately NOT re-exported from the package root: pulling this in means pulling
 * zod in, and only net consumers should pay that.
 */

export * from './constants';
export * from './ids';
export * from './messages';
export * from './character';
export * from './input';
export * from './snapshot';
