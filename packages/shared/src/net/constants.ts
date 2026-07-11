/**
 * Wire-protocol tuning knobs — the single source of truth both apps/realtime and the
 * web client import (Decision #6 in feature-plans/multiplayer/00-overview.md).
 */

/** Bumped on every breaking wire change; the server rejects mismatched hellos. */
export const PROTOCOL_VERSION = 1;

/** WebSocket upgrade path on the realtime server. */
export const REALTIME_PATH = '/realtime';

/** Default port for the local dev realtime server. */
export const DEFAULT_REALTIME_PORT = 8090;

// ── Tick rates (Phase 3 consumes SIM/SNAPSHOT/INPUT; Phase 2 only the relay) ──
export const SIM_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 30;

/** TEMPORARY (Phase 2 hub relay): client transform publish + server rebroadcast rate. */
export const TRANSFORM_RELAY_HZ = 15;

/** How far in the past remote entities are rendered (snapshot interpolation). */
export const INTERP_DELAY_MS = 100;

// ── Heartbeat / clock sync ────────────────────────────────────────────────────
/** Server → client ping cadence; each round-trip feeds the RTT EWMA. */
export const HEARTBEAT_INTERVAL_MS = 2000;
/** EWMA smoothing factor for RTT and clock-offset estimates (higher = snappier). */
export const PING_EWMA_ALPHA = 0.25;
/** No pong for this long → the server drops the connection as dead. */
export const HEARTBEAT_TIMEOUT_MS = 8000;

// ── Sessions ─────────────────────────────────────────────────────────────────
export const SESSION_MAX_PLAYERS = 4;
export const SESSION_CODE_LENGTH = 6;
/** Empty sessions are GC'd this long after the last player leaves. */
export const SESSION_GC_GRACE_MS = 60_000;
/** A disconnected player may resume (same playerId) within this window. */
export const RESUME_WINDOW_MS = 120_000;
/** How often the server broadcasts the member/ping roster. */
export const SESSION_STATE_INTERVAL_MS = 1000;

// ── TEMPORARY Phase 2 relay sanity clamps (Phase 3 deletes the relay entirely) ─
/**
 * Max plausible horizontal speed, world units/sec. The dodge dash peaks at
 * DODGE_DISTANCE / DODGE_DURATION_MS ≈ 22.2 u/s — anything past this is a teleport.
 */
export const RELAY_MAX_SPEED = 24;
/** Slack multiplier on the speed clamp (network jitter between updates). */
export const RELAY_SPEED_TOLERANCE = 1.5;
/** Hub playable clearing radius (matches resolveHubCollisions' outer clamp). */
export const HUB_BOUNDS_RADIUS = 28;
/** Vertical sanity range for relayed positions, world units. */
export const RELAY_MIN_Y = -2;
export const RELAY_MAX_Y = 40;

// ── Anim flag bitmask carried alongside relayed transforms ────────────────────
export const ANIM_FLAG_SPRINT = 1 << 0;
export const ANIM_FLAG_AIRBORNE = 1 << 1;
