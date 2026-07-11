import { z } from 'zod';
import type { PlayerId } from '../types';
import { PROTOCOL_VERSION } from './constants';

/**
 * Protocol v1 control messages — JSON envelopes for everything in Phase 2 (the binary
 * hot path arrives in Phase 3). CLIENT → SERVER messages carry zod schemas because the
 * browser is hostile: the server safe-parses every inbound frame and never trusts shape.
 * SERVER → CLIENT messages are plain interfaces — clients import the *types* only, so
 * zod stays out of the web bundle's hot path.
 */

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

// ── Client → Server ──────────────────────────────────────────────────────────

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  name: z.string().min(1).max(24),
  /** PlayerCharacterId on the client; opaque string on the wire. */
  character: z.string().min(1).max(32),
});

export const createSessionSchema = z.object({ type: z.literal('createSession') });

export const joinSessionSchema = z.object({
  type: z.literal('joinSession'),
  code: z.string().min(1).max(12),
  /** Present on reconnect — reclaims the same playerId within the resume window. */
  resumeToken: z.string().max(64).optional(),
});

export const leaveSessionSchema = z.object({ type: z.literal('leaveSession') });

/** TEMPORARY (Phase 2 hub relay) — Phase 3 replaces this with binary InputCmds. */
export const transformUpdateSchema = z.object({
  type: z.literal('transformUpdate'),
  /** Position, world units. */
  p: vec3,
  /** Y-axis facing, radians. */
  r: z.number().finite(),
  /** ANIM_FLAG_* bitmask. */
  a: z.number().int().nonnegative().max(0xff),
});

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
  transformUpdateSchema,
  pongSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;
export type TransformUpdateMessage = z.infer<typeof transformUpdateSchema>;

/** Convenience for building a spec-correct hello. */
export const makeHello = (name: string, character: string): HelloMessage => ({
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  name,
  character,
});

// ── Server → Client ──────────────────────────────────────────────────────────

export interface SessionMemberInfo {
  id: PlayerId;
  name: string;
  character: string;
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

export interface RelayedTransform {
  id: PlayerId;
  p: [number, number, number];
  r: number;
  a: number;
  /** Server wall-clock ms when this transform was accepted — the interp timeline. */
  t: number;
}

/** TEMPORARY (Phase 2 hub relay) — batched peer transforms at TRANSFORM_RELAY_HZ. */
export interface TransformBatchMessage {
  type: 'transformBatch';
  transforms: RelayedTransform[];
}

export interface PingMessage {
  type: 'ping';
  /** Server wall-clock ms at send. Client echoes it back in pong. */
  t: number;
  /** The recipient's own EWMA RTT as of the last round-trip (null before the first). */
  yourPing: number | null;
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
  | TransformBatchMessage
  | PingMessage
  | ErrorMessage;
