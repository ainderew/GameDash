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

/** A member at the Expedition Gate pressed E → start the shared 5 s countdown (hub only). */
export const requestZoneCountdownSchema = z.object({ type: z.literal('requestZoneCountdown') });

/** Any member cancels an in-progress expedition countdown. */
export const cancelZoneCountdownSchema = z.object({ type: z.literal('cancelZoneCountdown') });

/** Return the whole party to the hub (from the hunt-failed overlay / an expedition exit). */
export const returnToHubSchema = z.object({ type: z.literal('returnToHub') });

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
  requestZoneCountdownSchema,
  cancelZoneCountdownSchema,
  returnToHubSchema,
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

/**
 * A relic flight fully described by its launch params (Phase 5). Identical shape to sim's
 * `RelicFlightParams` (structural match — shared must not depend on sim). Every client
 * reconstructs the IDENTICAL arc from these alone.
 */
export interface RelicFlightWire {
  mode: 'pass' | 'lob';
  from: [number, number, number];
  control: [number, number, number];
  to: [number, number, number];
  arcHeight: number;
  /** Sim-time (ms) the flight started — the shared clock clients sample against. */
  startedAt: number;
  flightMs: number;
  /** Receiver avatar entity id (pass only; 0/absent for lobs). */
  targetId?: number;
  /** Thrower avatar entity id. */
  throwerId?: number;
}

/**
 * The relic's live state for a joining/reconnecting client (Phase 5, Task 5): enough to
 * reconstruct it from scratch — its entity id + phase, its grounded/carrier position, the
 * carrier (if carried), and the active flight params (if inFlight) so a mid-flight joiner
 * rebuilds the arc.
 */
export interface RelicWelcomeState {
  entityId: number;
  phase: 'carried' | 'inFlight' | 'grounded';
  pos: [number, number, number];
  /** Carrier avatar entity id (carried only). */
  carrierId?: number;
  /** Active flight params (inFlight only). */
  flight?: RelicFlightWire;
}

export interface WelcomeMessage {
  type: 'welcome';
  playerId: PlayerId;
  resumeToken: string;
  session: { code: string; members: SessionMemberInfo[] };
  /** Server wall-clock ms — seeds the client's serverTimeOffset estimate. */
  serverTime: number;
  /** Present in expedition: the live relic so a joiner/reconnector reconstructs it. */
  relic?: RelicWelcomeState;
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
   * Hitstun window length, ms (Phase 4). A monster hit's shove carries the stagger so the
   * client freezes for the same number of ticks the server does; 0/absent = pure knockback.
   */
  staggerMs?: number;
  /**
   * Present ONLY on the copy sent to the entity's owner: the input seq the impulse is
   * applied before (server-known, so the client keys its replay stream without
   * tick↔seq estimation error).
   */
  seq?: number;
}

// ── Phase 4: authoritative expedition combat (reliable events) ────────────────
// Discrete gameplay outcomes the server decides and the client only reacts to. Every
// event carries the `serverTick` it happened at so the client can apply it AT/AFTER that
// tick in interpolation time — a death event never lands before the snapshot showing the
// corpse (plan Risk: "Event ordering vs snapshots").

/** The session moved the whole party between the hub and an expedition zone. */
export interface ZoneChangedMessage {
  type: 'zoneChanged';
  zone: 'hub' | 'expedition';
  serverTick: number;
}

/**
 * The shared expedition-gate countdown ticking down (Phase 6 Task 2). `active` opens/holds the
 * on-screen banner; `secondsLeft` drives it; on cancel the server sends `active:false`. When it
 * reaches zero the server flips the zone and a `zoneChanged` follows.
 */
export interface ZoneCountdownMessage {
  type: 'zoneCountdown';
  active: boolean;
  secondsLeft: number;
  serverTick: number;
}

/** A monster entered the world — clients create its render entity + play spawn FX. */
export interface MonsterSpawnedMessage {
  type: 'monsterSpawned';
  serverTick: number;
  id: number;
  archetype: string;
  pos: [number, number, number];
}

/** A monster left the world (killed or culled) — clients destroy it + play death FX. */
export interface MonsterDespawnedMessage {
  type: 'monsterDespawned';
  serverTick: number;
  id: number;
  reason: 'killed' | 'cull';
  /** Death position (FX). */
  pos: [number, number, number];
}

/** A new wave began — drives the HUD wave/count. */
export interface WaveStartedMessage {
  type: 'waveStarted';
  serverTick: number;
  wave: number;
  count: number;
}

/**
 * A hit the server CONFIRMED. Drives every client feel system on the receiving end:
 * floating numbers, hitstop, screenshake, flash, knockback visuals. Fires for hits on
 * monsters AND players (a player taking damage). `targetKind` lets the client route it.
 */
export interface DamageDealtMessage {
  type: 'damageDealt';
  serverTick: number;
  targetId: number;
  targetKind: 'player' | 'monster';
  /** Entity id of the attacker (0 = none/environment). */
  sourceId: number;
  amount: number;
  strength: 'light' | 'heavy';
  crit: boolean;
  /** Contact point (sparks + shockwave). */
  point: [number, number, number];
  /** Unit knockback direction on XZ. */
  dir: [number, number];
}

/** A player's parry negated an incoming hit — drives the reward flourish. */
export interface ParrySuccessMessage {
  type: 'parrySuccess';
  serverTick: number;
  playerId: PlayerId;
}

/** A player was downed (0 HP; NOT despawned — awaits a co-op revive). */
export interface PlayerDownedMessage {
  type: 'playerDowned';
  serverTick: number;
  playerId: PlayerId;
}

/** A downed player was revived by a teammate. */
export interface PlayerRevivedMessage {
  type: 'playerRevived';
  serverTick: number;
  playerId: PlayerId;
}

/** Every party member is downed — the hunt failed; the session returns to the hub. */
export interface HuntFailedMessage {
  type: 'huntFailed';
  serverTick: number;
}

/**
 * SHARED-POOL loot tally: a pickup was collected and every member's material count is now
 * `total`. Server-authoritative — the client's `materials` mirrors this, never local pickups.
 */
export interface MaterialTallyMessage {
  type: 'materialTally';
  serverTick: number;
  tableId: string;
  total: number;
}

// ── Phase 5: relic relay (reliable events) ────────────────────────────────────
// The server OWNS the relic state machine; clients only react. Every event carries the
// `serverTick` it happened at (ordered vs snapshots, like Phase 4's combat events). The
// receiver-feedback plan routes all juice through these events, so once they arrive over the
// wire every feedback effect (arc, ring, chime, catch shockwave VFX) comes along for free.

/**
 * A relic flight began — a targeted pass, an intentional lob, a failed-pass bounce, or a
 * disconnect drop. Carries the full deterministic flight so every client plays the identical
 * arc. `RelicPassFailed`/`RelicDropped` may accompany it to drive the matching feedback.
 */
export interface RelicLaunchedMessage {
  type: 'relicLaunched';
  serverTick: number;
  flight: RelicFlightWire;
}

/** The server resolved a catch — drives attach + shockwave VFX + catcher-side catch juice. */
export interface RelicCaughtMessage {
  type: 'relicCaught';
  serverTick: number;
  carrierId: number;
  pos: [number, number, number];
}

/** A targeted pass failed at arrival (receiver downed/escaped) — drives the fail feedback. */
export interface RelicPassFailedMessage {
  type: 'relicPassFailed';
  serverTick: number;
  reason: 'receiver_downed' | 'receiver_escaped';
  pos: [number, number, number];
}

/** The relic was dropped as a lob (intentional G, or a carrier disconnect). */
export interface RelicDroppedMessage {
  type: 'relicDropped';
  serverTick: number;
  reason: 'intentional' | 'disconnect';
  pos: [number, number, number];
}

/** A flight ended on the ground (no catch) — clients settle the relic to its hover. */
export interface RelicGroundedMessage {
  type: 'relicGrounded';
  serverTick: number;
  pos: [number, number, number];
}

/**
 * The server refused a pass intent (not the carrier, target invalid, out of range/cone, or
 * the rotation rule) — the thrower snaps the relic back to the shoulder with fail feedback.
 */
export interface PassRejectedMessage {
  type: 'passRejected';
  serverTick: number;
  reason: 'not_carrier' | 'target_invalid' | 'out_of_range' | 'rotation';
}

export type NetErrorCode =
  | 'version_mismatch'
  | 'bad_message'
  | 'hello_required'
  | 'unknown_session'
  | 'session_full'
  | 'already_in_session'
  | 'not_in_session'
  | 'server_full';

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
  | ZoneChangedMessage
  | ZoneCountdownMessage
  | MonsterSpawnedMessage
  | MonsterDespawnedMessage
  | WaveStartedMessage
  | DamageDealtMessage
  | ParrySuccessMessage
  | PlayerDownedMessage
  | PlayerRevivedMessage
  | HuntFailedMessage
  | MaterialTallyMessage
  | RelicLaunchedMessage
  | RelicCaughtMessage
  | RelicPassFailedMessage
  | RelicDroppedMessage
  | RelicGroundedMessage
  | PassRejectedMessage
  | ErrorMessage;
