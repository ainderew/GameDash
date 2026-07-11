/**
 * Playable character ids on the wire. Was an opaque string through Phase 2; enumed here
 * (Phase 3) so the protocol validates it and both sides share one source of truth —
 * apps/web's PLAYER_CHARACTERS registry keys off this type.
 */
export const CHARACTER_IDS = ['hero', 'druid', 'trickster'] as const;

export type CharacterId = (typeof CHARACTER_IDS)[number];

export const isCharacterId = (v: string): v is CharacterId =>
  (CHARACTER_IDS as readonly string[]).includes(v);

/** Wire fallback: unknown/legacy character strings collapse to the default model. */
export const DEFAULT_CHARACTER_ID: CharacterId = 'hero';
