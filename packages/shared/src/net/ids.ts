import type { PlayerId } from '../types';

/**
 * Identity helpers for sessions and players. Codes are human-typed (friend reads it
 * over voice), so the alphabet drops lookalikes (I/L/O/0/1).
 */

export type SessionCode = string;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;

/** 6-char join code from the unambiguous alphabet. `random` injectable for tests. */
export const generateSessionCode = (random: () => number = Math.random): SessionCode => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
};

/** Uppercase + trim user input before validation ("ab c123" never joins anything). */
export const normalizeSessionCode = (raw: string): string => raw.trim().toUpperCase();

export const isSessionCode = (value: string): value is SessionCode => CODE_RE.test(value);

/** Random url-safe hex string. Uses WebCrypto when present (browser + Node ≥19). */
const randomHex = (bytes: number): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    cryptoApi.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
};

/** Server-issued guest identity (Decision #9 — Supabase auth comes later). */
export const generatePlayerId = (): PlayerId => `p_${randomHex(8)}`;

/** Secret that lets a disconnected client reclaim its playerId on reconnect. */
export const generateResumeToken = (): string => `rt_${randomHex(16)}`;
