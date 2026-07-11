import { z } from 'zod';
import type { PlayerId } from '../types';
import { PROTOCOL_VERSION } from './constants';
import { CHARACTER_IDS, type CharacterId } from './character';

/**
 * Protocol v2 control messages — JSON envelopes for the reliable channel. The hot path
 * (InputCmds, snapshots) is BINARY and lives in ./input.ts + ./snapshot.ts. CLIENT →
 * SERVER messages carry zod schemas because the browser is hostile: the server
 * safe-parses every inbound frame and never trusts shape. SERVER → CLIENT messages are
 * plain interfaces — clients import the *types* only, so zod stays out of the web
 * bundle's hot path.
 *
 * Phase 3 note: the Phase 2 transform relay (`transformUpdate`/`transformBatch`) is GONE.
 * Clients send intent, never state — a v1 client's transformUpdate now fails schema
 * validation outright (the server rejects client transforms by construction).
 */

// ── Client → Server ──────────────────────────────────────────────────────────

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  name: z.string().min(1).max(24),
  character: z.enum(CHARACTER_IDS),
});

export const createSessionSchema = z.object({ type: z.literal('createSession') });

export const joinSessionSchema = z.object({
  type: z.literal('joinSession'),
  code: z.string().min(1).max(12),
  /** Present on reconnect — reclaims the same playerId within the resume window. */
  resumeToken: z.string().max(64).optional(),
});

export const leaveSessionSchema = z.object({ type: z.literal('leaveSession') });

export const pongSchema = z.object({
  type: z.literal('pong'),
  /** Echo of ping.t (server wall-clock ms) — the server derives RTT from it. */
  t: z.number().finite(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  createSessionSchema,
  joinSessionSchema,
  leaveSessionSchema,
  pongSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;

/** Convenience for building a spec-correct hello. */
export const makeHello = (name: string, character: CharacterId): HelloMessage => ({
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  name,
  character,
});

// ── Server → Client ──────────────────────────────────────────────────────────

export interface SessionMemberInfo {
  id: PlayerId;
  name: string;
  character: CharacterId;
  /** The member's avatar entity id inside the session world — snapshot records use it. */
  entityId: number;
  /** EWMA RTT in ms; null until the first heartbeat round-trip completes. */
  ping: number | null;
  connected: boolean;
}

export interface WelcomeMessage {
  type: 'welcome';
  playerId: PlayerId;
  resumeToken: string;
  session: { code: string; members: SessionMemberInfo[] };
  /** Server wall-clock ms — seeds the client's serverTimeOffset estimate. */
  serverTime: number;
}

export interface PlayerJoinedMessage {
  type: 'playerJoined';
  member: SessionMemberInfo;
}

export interface PlayerLeftMessage {
  type: 'playerLeft';
  playerId: PlayerId;
  reason: 'left' | 'disconnected';
}

/** ~1 Hz roster broadcast: every member's live EWMA ping (feeds the PingCard). */
export interface SessionStateMessage {
  type: 'sessionState';
  code: string;
  members: SessionMemberInfo[];
  serverTime: number;
}

export interface PingMessage {
  type: 'ping';
  /** Server wall-clock ms at send. Client echoes it back in pong. */
  t: number;
  /** The recipient's own EWMA RTT as of the last round-trip (null before the first). */
  yourPing: number | null;
}

/**
 * A server-initiated force on an entity (knockback, stagger shove, catch shockwave),
 * applied by the server sim at `tick`. The owning client applies it immediately AND
 * injects it into its prediction replay stream keyed by tick, so reconciliation replays
 * it alongside inputs instead of fighting it (no-rubberband contract #3).
 */
export interface ImpulseMessage {
  type: 'impulse';
  tick: number;
  entityId: number;
  /** World units/sec: XZ enters the knockback decay, Y adds to vertical velocity. */
  impulse: [number, number, number];
  /**
   * Present ONLY on the copy sent to the entity's owner: the input seq the impulse is
   * applied before (server-known, so the client keys its replay stream without
   * tick↔seq estimation error).
   */
  seq?: number;
}

export type NetErrorCode =
  | 'version_mismatch'
  | 'bad_message'
  | 'hello_required'
  | 'unknown_session'
  | 'session_full'
  | 'already_in_session'
  | 'not_in_session';

export interface ErrorMessage {
  type: 'error';
  code: NetErrorCode;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | SessionStateMessage
  | PingMessage
  | ImpulseMessage
  | ErrorMessage;
