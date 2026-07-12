/**
 * Wire-protocol tuning knobs — the single source of truth both apps/realtime and the
 * web client import (Decision #6 in feature-plans/multiplayer/00-overview.md).
 */

/** Bumped on every breaking wire change; the server rejects mismatched hellos.
 * v2: Phase 3 — transform relay deleted, binary InputCmds + snapshots. */
export const PROTOCOL_VERSION = 2;

/** WebSocket upgrade path on the realtime server. */
export const REALTIME_PATH = '/realtime';

/** Default port for the local dev realtime server. */
export const DEFAULT_REALTIME_PORT = 8090;

// ── Tick rates ────────────────────────────────────────────────────────────────
export const SIM_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 30;

/** Milliseconds per fixed sim tick. Server time = serverTick × MS_PER_TICK. */
export const MS_PER_TICK = 1000 / SIM_HZ;

/** Full-state snapshot cadence; deltas in between reference the last keyframe. */
export const SNAPSHOT_KEYFRAME_INTERVAL_MS = 2000;

// ── Interpolation (remote entities render this far in the past) ─────────────
/** Base/minimum interp delay. The client adapts upward on measured jitter. */
export const INTERP_DELAY_MS = 100;
/** Adaptive interp delay bounds + shrink rate (grow instantly, shrink slowly). */
export const INTERP_DELAY_MAX_MS = 300;
export const INTERP_DELAY_SHRINK_PER_S = 5;
/** Underrun policy: hold ≤ HOLD, then dead-reckon ≤ DR, then hold (never guess wildly). */
export const INTERP_UNDERRUN_HOLD_MS = 100;
export const INTERP_UNDERRUN_DEADRECKON_MS = 150;

// ── Server input jitter buffer (no-rubberband contract #2) ───────────────────
/**
 * Initial/target cmds buffered ahead of consumption. Warm-started at 3 (one tick above
 * the steady-state 1–2 target) because the arrival-jitter EWMA needs a few packets to
 * calibrate — a single startup starvation at sprint speed costs a ~20 cm correction,
 * which the no-rubberband KPI treats as a bug. Calm links shrink back within seconds.
 */
export const JITTER_BUFFER_INITIAL_DEPTH = 3;
/** Depth never adapts beyond this. */
export const JITTER_BUFFER_MAX_DEPTH = 5;
/** Cmds buffered beyond target+this get their oldest dropped (bounded latency). */
export const JITTER_BUFFER_OVERFLOW_SLACK = 8;
/** Ticks without starvation before the target depth shrinks by one. */
export const JITTER_BUFFER_SHRINK_TICKS = 600; // 20 s at 30 Hz
/** Starvation coasts on the last movement cmd for at most this many ticks, then stops. */
export const STARVATION_COAST_MAX_TICKS = 8; // ≈ 266 ms

// ── Reconciliation ────────────────────────────────────────────────────────────
/** Divergence below this never corrects (must exceed pos quantization: 0.5 cm). */
export const RECONCILE_EPSILON_M = 0.02;
/** Divergence above this is a genuine teleport (spawn/zone change) → explicit snap. */
export const TELEPORT_EPSILON_M = 2;
/** Residual corrections fold into the PRESENTATION transform over this window. */
export const CORRECTION_SMOOTH_MS = 100;
/** Predicted-state ring size (seq history) — 128 ticks ≈ 4.3 s of unacked headroom. */
export const PREDICTION_RING_SIZE = 128;

// ── Lag compensation (Phase 4 consumes; recorded from Phase 3) ───────────────
/** Per-entity position history depth, ticks (≈ 266 ms at 30 Hz). */
export const POSITION_HISTORY_TICKS = 8;

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
/** Shared expedition-gate countdown length (any member can cancel before it hits zero). */
export const ZONE_COUNTDOWN_SECONDS = 5;
/** Default cap on concurrent sessions (env MAX_SESSIONS overrides). Room-server safety valve. */
export const DEFAULT_MAX_SESSIONS = 200;
/** A session with connected players but no input for this long is reaped (env override). */
export const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 600_000; // 10 min

// ── Per-connection rate limits (Phase 6 Task 3 hardening) ─────────────────────
/**
 * Fixed 1 s window caps a single socket may not exceed. The legit hot path is 30 Hz input
 * (binary) + a 2 s pong + rare control frames, so these are ~4× headroom over honest traffic;
 * a client that blows through them is buggy or hostile and its excess frames are dropped
 * (the connection survives — a flood must never crash the room).
 */
export const RATE_LIMIT_WINDOW_MS = 1000;
export const MAX_MSGS_PER_WINDOW = 150;
export const MAX_BYTES_PER_WINDOW = 131_072; // 128 KiB/s
/** Sustained windows fully over the cap before the socket is force-closed as abusive. */
export const RATE_LIMIT_ABUSE_WINDOWS = 5;

// ── Graceful shutdown (Phase 6 Task 4 deploy drain) ───────────────────────────
/** On SIGTERM the server notifies sessions then waits this long before exiting. */
export const SHUTDOWN_GRACE_MS = 10_000;

// ── Anim flag bitmask carried in snapshot records ─────────────────────────────
// Players use the low two bits; monsters repurpose the byte to pack their aiState + flags
// (a record's `kind` disambiguates which reading applies).
export const ANIM_FLAG_SPRINT = 1 << 0;
export const ANIM_FLAG_AIRBORNE = 1 << 1;
/** Player: true while downed (0 HP, awaiting revive) — drives the downed pose. */
export const ANIM_FLAG_DOWNED = 1 << 2;
/** Player: mid-swing (attackAnimUntil window) — remote avatars play the attack clip. */
export const ANIM_FLAG_ATTACK = 1 << 3;
/** Player: mid-dodge/roll (dodgingUntil window) — remote avatars play the roll clip. */
export const ANIM_FLAG_DODGE = 1 << 4;
/** Player: inside the server-authored hit-reaction window. */
export const ANIM_FLAG_HURT = 1 << 5;
/** Player: planted by a freshly completed Relic catch/pickup. */
export const ANIM_FLAG_RELIC_CATCH = 1 << 6;
/** Player: inside the follow-through window after launching the Relic. */
export const ANIM_FLAG_RELIC_THROW = 1 << 7;

// ── Monster snapshot anim flags (Phase 4) ─────────────────────────────────────
/** aiState packed into the low two bits: 0 idle · 1 chase · 2 attack · 3 cooldown. */
export const MON_AISTATE_MASK = 0b11;
export const MON_AISTATE = { idle: 0, chase: 1, attack: 2, cooldown: 3 } as const;
/** Staggered (knockback playing) — drives the hit-react pose. */
export const MON_FLAG_STAGGER = 1 << 2;
/** Began an attack this window — drives the lunge animation. */
export const MON_FLAG_ATTACK = 1 << 3;

// ── Relic snapshot flags (Phase 5) ────────────────────────────────────────────
/**
 * The relic's phase packed into its snapshot record's anim-flags byte (a record's `kind`
 * = relic disambiguates the reading). Snapshots are the COARSE truth (phase + grounded
 * pos, for drift + late-join reconciliation); the carrier binding and flight arc arrive as
 * reliable relic EVENTS, so the snapshot needs no carrier id or flight fields. */
export const RELIC_PHASE_FLAG = { carried: 0, inFlight: 1, grounded: 2 } as const;
export type RelicPhaseFlag = (typeof RELIC_PHASE_FLAG)[keyof typeof RELIC_PHASE_FLAG];
/** Reverse lookup for decoders (flag byte → phase name). */
export const RELIC_PHASE_OF: Record<number, 'carried' | 'inFlight' | 'grounded'> = {
  0: 'carried',
  1: 'inFlight',
  2: 'grounded',
};
