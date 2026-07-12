import type { PlayerId, Vector3Tuple } from '@shared/types';
import type { Faction, HitStrength } from '@shared/combat';
import type { MonsterArchetype } from '@shared/monsters';

/**
 * ECS component definitions. Entities are plain objects holding a subset of these.
 * Systems (see ./systems) read/mutate these each frame — never React state on the hot path.
 */

export interface Transform {
  position: Vector3Tuple;
  /** Y-axis facing in radians. */
  rotationY: number;
}

export interface Velocity {
  linear: Vector3Tuple;
}

export interface Health {
  current: number;
  max: number;
}

export type AiState = 'idle' | 'chase' | 'attack' | 'cooldown';

export interface AiBrain {
  state: AiState;
  /** Timestamp (ms) the monster last BEGAN an attack (windup start), for cooldown gating. */
  lastAttackAt: number;
  /**
   * When set, the monster is mid-windup and committed to strike at this timestamp (ms).
   * Damage lands only when `now >= strikeAt` AND the player is still in range — dodging
   * out of the telegraph whiffs the blow. Cleared on strike, stagger, or stand-down.
   */
  strikeAt?: number;
}

export interface AttackState {
  kind: 'melee' | 'ranged';
  /** performance.now() when the swing started. */
  startedAt: number;
  /** Monster entities already hit by the current swing (no multi-hit). */
  hitSet: Set<Entity>;
  /** Index into the melee combo chain this swing belongs to (melee only). */
  combo?: number;
}

export type RelicPhase = 'carried' | 'inFlight' | 'grounded';

/**
 * The living Relic — one entity per session. A small state machine driven by relicSystem:
 * carried (floats beside its carrier) → inFlight (a targeted pass or an untargeted lob) →
 * grounded (hovers where it landed until someone walks into it) → carried…
 */
export interface RelicState {
  phase: RelicPhase;
  /** Who holds it (carried only). */
  carrier?: Entity;
  /**
   * Flight kind: 'pass' = deterministic quadratic Bézier to a teammate's catch socket
   * (auto-caught on arrival, uninterceptable); 'lob' = untargeted parabola to a ground
   * point (intentional drop / failed pass), catchable by walk-in.
   */
  mode?: 'pass' | 'lob';
  /** Pass receiver (pass mode only). */
  target?: Entity;
  /** Who threw the current pass — their rotation cooldown is refunded if it fails. */
  thrower?: Entity;
  /** gameNow() of the last failed pass — drives the "hot" grounded marker pulse. */
  failedAt?: number;
  /** Why the last pass failed (netcode: surfaced as the RelicPassFailed wire reason). */
  failReason?: 'receiver_downed' | 'receiver_escaped';
  /** Flight start/end points in world space (inFlight only). `to` is the live endpoint. */
  from?: Vector3Tuple;
  to?: Vector3Tuple;
  /** Bézier control point (pass mode only). */
  control?: Vector3Tuple;
  /** The endpoint predicted at release — homing may correct `to` at most 3m from here. */
  endBase?: Vector3Tuple;
  /** gameNow() when the throw left the carrier's hands (inFlight only). */
  startedAt?: number;
  /** Total flight duration for the current throw, ms. */
  flightMs?: number;
  /** Peak height of the parabolic arc above the from→to line, world units (lob only). */
  arcHeight?: number;
  /** gameNow() before which no catch can happen — prevents instant self-recatch. */
  noCatchUntil?: number;
}

export interface Entity {
  /**
   * Stable numeric id, stamped by GameWorld.add (per-world counter). Object refs can't
   * cross the wire — every networked message addresses entities by this id.
   */
  id?: number;
  /** Which player owns/controls this entity (player avatars, their projectiles later). */
  ownerId?: PlayerId;
  transform?: Transform;
  velocity?: Velocity;
  health?: Health;
  /** Marks a player-controlled entity — ANY human's avatar, local or remote. */
  playerControlled?: true;
  /**
   * Marks THE entity the local client owns (prediction, HUD, camera). Client-only marker:
   * the server never sets it; sim systems must not branch on it for gameplay outcomes.
   */
  localPlayer?: true;
  /**
   * Marks another human's avatar mirrored from the network (Phase 2: hub transform relay;
   * Phase 3: snapshots). Client-side marker — driven by interpolation, never by intents.
   */
  remotePlayer?: true;
  /**
   * This entity's id in the SERVER/session world (set on client remote-player mirrors from the
   * roster). Distinct from `id` (the local client world's stamp) — pass targeting resolves a
   * chosen receiver to this so the server validates the pass against the right avatar.
   */
  serverEntityId?: number;
  /** Reach multiplier of the wielded weapon (loadout data, synced by the client adapter). */
  weaponReachMul?: number;
  /**
   * gameNow() of the last melee press, kept while it stays buffered (input buffering lives
   * on the entity so the identical logic runs during server-side replay). See stepSim.
   */
  meleeBufferedAt?: number;
  /** True while this carrier is aiming a pass — steadies the carried Relic's anchor. */
  passAiming?: boolean;
  /** Number of jumps used since the player last touched the ground (maximum two). */
  jumpsUsed?: number;
  /** Timestamp (ms, performance.now) until which the entity has i-frames. */
  iframeUntil?: number;
  /** Timestamp (ms) until which the entity is mid-dodge (dash active). */
  dodgingUntil?: number;
  /** Timestamp (ms) after which another dodge may start. */
  dodgeReadyAt?: number;
  /** Dodge dash direction (unit-ish), consumed by the movement system. */
  dodgeDir?: Vector3Tuple;

  // ── Combat ──────────────────────────────────────────────────────────────
  /** Which side the entity is on; hostility gates damage. */
  faction?: Faction;
  /** Present while a melee swing is active. */
  attackState?: AttackState;
  /** gameNow() when the current melee swing began (outlives attackState, for FX/indicator). */
  meleeStartedAt?: number;
  /**
   * gameNow() until which the current swing's animation runs. While set in the future the
   * player is ROOTED (no walk/turn/jump) and the attack clip plays; a dodge zeroes it — the
   * animation cancel.
   */
  attackAnimUntil?: number;
  /** Timestamp (ms) after which the player may melee again. */
  meleeReadyAt?: number;
  /** Index of the last melee combo move performed. */
  meleeCombo?: number;
  /** Timestamp (ms) until which the next melee press continues the combo chain. */
  meleeComboExpiresAt?: number;
  /** Timestamp (ms) after which the player may fire again. */
  rangedReadyAt?: number;

  // ── Co-op downed / revive (Phase 4 netcode) ──────────────────────────────
  /**
   * True while a player is DOWNED (brought to 0 HP but not despawned). Cleared on revive.
   * Server-authoritative: healthSystem sets it, reviveSystem clears it. Downed players are
   * inert — aiSystem ignores them as targets and they cannot act.
   */
  downed?: boolean;
  /** Accumulated revive progress on this downed player, ms (reviveSystem owns it). */
  reviveProgressMs?: number;
  /** True this tick if the player is holding the revive input (decoded from BTN_PARRY reuse → dedicated). */
  reviving?: boolean;

  // ── Monster ─────────────────────────────────────────────────────────────
  monster?: MonsterArchetype;
  aiBrain?: AiBrain;
  /** Loot table granted on death. */
  lootTableId?: string;
  attackDamage?: number;
  attackRange?: number;
  attackCooldownMs?: number;
  /** Telegraph duration: ms from attack start until the blow actually lands (aiSystem windup). */
  attackWindupMs?: number;
  moveSpeed?: number;
  ranged?: boolean;
  /** Body radius for hit tests + rendering. */
  radius?: number;
  /** Timestamp (gameNow ms) until which the entity renders a hit flash. */
  hitFlashUntil?: number;
  /** gameNow() when the entity last took damage — drives HP bar visibility/fade. */
  lastDamagedAt?: number;
  /** Flash tint as linear RGB (white for light hits, red for heavy), read by renderers. */
  hitFlashColor?: Vector3Tuple;
  /** gameNow() when the monster last began an attack, driving its lunge animation. */
  attackStartedAt?: number;

  // ── Combat feel: reaction + knockback ─────────────────────────────────────
  /** Decaying knockback velocity (world units/sec, mostly XZ) applied by knockbackSystem. */
  knockback?: Vector3Tuple;
  /** gameNow() until which the entity is staggered — can't act while knockback plays. */
  staggerUntil?: number;
  /** gameNow() when the current hit-reaction (squash & stretch) began. */
  hitReactionAt?: number;
  /** Strength of the current hit reaction, selecting squash amount + flash look. */
  hitReactionStrength?: HitStrength;
  /** gameNow() until which the player's parry/block window is open (parry seam). */
  blockingUntil?: number;

  // ── Projectile ──────────────────────────────────────────────────────────
  projectile?: true;
  /** performance.now() when the projectile spawned (lifetime gate). */
  spawnedAt?: number;
  /** Damage applied on projectile hit. */
  damage?: number;

  // ── Pickup ──────────────────────────────────────────────────────────────
  pickup?: { tableId: string };

  // ── Relic ───────────────────────────────────────────────────────────────
  relic?: RelicState;
  /** gameNow() until which this player can't receive the Relic (post-pass rotation rule). */
  relicRecatchUntil?: number;
  /**
   * gameNow() until which the player is planted after catching the Relic — movementSystem
   * zeroes their velocity so the catch clip doesn't glide. Dodge/attack break it early.
   */
  catchRootUntil?: number;

  // ── Teammate (local stand-in for other players until netcode lands) ──────
  teammate?: true;
  /** Simple back-and-forth patrol between two XZ points, driven by teammateSystem. */
  patrol?: { a: [number, number]; b: [number, number]; toB: boolean };
  /** gameNow() when this teammate caught the Relic — they pass it back after a hold. */
  relicHeldSince?: number;

  // ── FX ──────────────────────────────────────────────────────────────────
  /** Floating damage number: transient, aged out by floatingNumberSystem. */
  floatingNumber?: { amount: number; spawnedAt: number; crit: boolean };
  /**
   * Impact VFX marker (spark burst / shockwave ring) spawned at a contact point.
   * Aged on REAL time (`spawnedAtReal`) so it bursts while the sim is frozen for hitstop.
   */
  impactFx?: {
    kind: 'spark' | 'ring';
    strength: HitStrength;
    /** performance.now() at spawn — real-time so it animates during hitstop. */
    spawnedAtReal: number;
    lifetimeMs: number;
    color: Vector3Tuple;
    /** Spark shard count (spark only). */
    count: number;
    /** Final radius the effect expands to. */
    radius: number;
    /** Impact-out direction on XZ. Sparks use this to inherit the sword's momentum. */
    dirX: number;
    dirZ: number;
  };
  /**
   * Relic-claim burst marker (client-only, spawned by simHooks.onRelicCaught). One entity
   * drives the whole orchestrated catch effect — absorption inrush, core flash, sunburst
   * rays, expanding dome, shockwave ring, sparks. Aged on REAL time so it plays through the
   * catch hitstop; removed by the RelicCatchFX renderer when it finishes.
   */
  catchBurstFx?: { spawnedAtReal: number };
}
