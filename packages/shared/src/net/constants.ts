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

// ── Anim flag bitmask carried in snapshot records ─────────────────────────────
// Players use the low two bits; monsters repurpose the byte to pack their aiState + flags
// (a record's `kind` disambiguates which reading applies).
export const ANIM_FLAG_SPRINT = 1 << 0;
export const ANIM_FLAG_AIRBORNE = 1 << 1;
/** Player: true while downed (0 HP, awaiting revive) — drives the downed pose. */
export const ANIM_FLAG_DOWNED = 1 << 2;

// ── Monster snapshot anim flags (Phase 4) ─────────────────────────────────────
/** aiState packed into the low two bits: 0 idle · 1 chase · 2 attack · 3 cooldown. */
export const MON_AISTATE_MASK = 0b11;
export const MON_AISTATE = { idle: 0, chase: 1, attack: 2, cooldown: 3 } as const;
/** Staggered (knockback playing) — drives the hit-react pose. */
export const MON_FLAG_STAGGER = 1 << 2;
/** Began an attack this window — drives the lunge animation. */
export const MON_FLAG_ATTACK = 1 << 3;
