import { InterpBuffer } from '@sim/interp';
import type { ServerMessage, SessionMemberInfo } from '@shared/net/messages';
import { makeHello } from '@shared/net/messages';
import {
  INTERP_DELAY_MS,
  INTERP_DELAY_MAX_MS,
  INTERP_DELAY_SHRINK_PER_S,
  PING_EWMA_ALPHA,
} from '@shared/net/constants';
import { decodeSnapshot, type DecodedEntityRecord } from '@shared/net/snapshot';
import { DEFAULT_CHARACTER_ID, isCharacterId, type CharacterId } from '@shared/net/character';
import { useUIStore, type SessionMemberUI } from '@/ui/store';
import { realtimeUrl, createTransport, type Transport } from '@/net/transport';
import { netGame } from '@/net/netGame';
import { netStats } from '@/net/netStats';
import { relicNet } from '@/net/relicNet';

/**
 * THE session client: connection state machine (idle → connecting → joined), message
 * dispatch, the binary snapshot pipeline (Phase 3 — decode, feed the local player's
 * reconciliation and the remote interp buffers), tick-domain clock sync, and the
 * adaptive interpolation delay.
 *
 * Doctrine split: session/roster/ping → zustand (UI, inherently ≤1 Hz updates);
 * remote SNAPSHOT STATE → interp buffers read by the render loop (never React state).
 */

type PendingIntent =
  | { kind: 'create' }
  | { kind: 'join'; code: string }
  | { kind: 'resume'; code: string; resumeToken: string };

const toMemberUI = (m: SessionMemberInfo): SessionMemberUI => ({
  id: m.id,
  name: m.name,
  character: m.character,
  entityId: m.entityId,
  ping: m.ping,
  connected: m.connected,
});

/** Full remote state per snapshot: keyframe baseline patched by stateless deltas. */
interface RemoteEntityState {
  pos: [number, number, number];
  rotY: number;
  hp: number;
  vel: [number, number, number];
  flags: number;
}

class NetClient {
  private transport: Transport | null = null;
  private profile: { name: string; character: CharacterId } = { name: 'Adventurer', character: DEFAULT_CHARACTER_ID };
  private pending: PendingIntent | null = null;
  /** Set once joined — reused to resume across reconnects. */
  private joined: { code: string; resumeToken: string } | null = null;

  /** OUR playerId + avatar entity id in the session world (from welcome/roster). */
  private ownPlayerId: string | null = null;
  private ownEntityId: number | null = null;
  /** entityId → playerId for remote records. */
  private readonly entityOwners = new Map<number, string>();
  /** Last integer HP pushed to the store per player-entity — gates HP updates to real changes. */
  private readonly lastMemberHp = new Map<number, number>();

  // ── Clock sync: server TICK time ↔ performance.now() ────────────────────────
  /** serverTickTimeMs − performance.now() EWMA (fed by snapshot headers). */
  private tickTimeOffset: number | null = null;
  /** Wall-clock fallback offset (heartbeats) — used before the first snapshot. */
  private wallOffset: number | null = null;

  // ── Adaptive interp delay ────────────────────────────────────────────────────
  private interpDelay = INTERP_DELAY_MS;
  private lastSnapshotAt: number | null = null;
  private readonly arrivalGaps: number[] = [];
  private lastDelayUpdateAt = 0;

  // ── Snapshot baselines (keyframes), keyed by keyframe tick — keep the last 2 ──
  private readonly baselines = new Map<number, Map<number, RemoteEntityState>>();

  /** Per-remote-player snapshot buffers, keyed by PlayerId. */
  private readonly remoteBuffers = new Map<string, InterpBuffer>();

  // ── Public API (used by useSession / MainMenu / SystemRunner) ───────────────
  createSession(name: string, character: CharacterId): void {
    this.start({ kind: 'create' }, name, character);
  }

  joinSession(code: string, name: string, character: CharacterId): void {
    this.start({ kind: 'join', code }, name, character);
  }

  leaveSession(): void {
    this.transport?.send({ type: 'leaveSession' });
    this.disconnect();
  }

  /** Gate interaction: any member starts / cancels the shared expedition countdown. */
  requestZoneCountdown(): void {
    this.transport?.send({ type: 'requestZoneCountdown' });
  }
  cancelZoneCountdown(): void {
    this.transport?.send({ type: 'cancelZoneCountdown' });
  }
  /** Hunt-failed overlay / expedition exit: return the whole party to the hub. */
  returnToHub(): void {
    this.transport?.send({ type: 'returnToHub' });
  }

  disconnect(): void {
    netGame.resetEpoch();
    this.transport?.close();
    this.transport = null;
    this.pending = null;
    this.joined = null;
    this.ownPlayerId = null;
    this.ownEntityId = null;
    this.entityOwners.clear();
    this.lastMemberHp.clear();
    this.baselines.clear();
    this.remoteBuffers.clear();
    this.tickTimeOffset = null;
    this.wallOffset = null;
    relicNet.setOwnEntity(null);
    relicNet.reset();
    const store = useUIStore.getState();
    store.setSession(undefined);
    store.setConnectionState('offline');
    store.setZoneCountdown(null);
    store.setRelicCarrier(null);
  }

  /** Send an input packet on the binary hot path (SystemRunner → netGame → here). */
  sendInput = (data: ArrayBuffer): void => {
    this.transport?.sendBinary(data);
  };

  /**
   * Estimated server "now" on the shared timeline, ms. Server-TICK time once snapshots
   * flow (the timeline snapshot states are stamped with); wall-clock estimate before.
   */
  serverNow(): number {
    if (this.tickTimeOffset !== null) return performance.now() + this.tickTimeOffset;
    if (this.wallOffset !== null) return performance.now() + this.wallOffset;
    return Date.now();
  }

  /** Current adaptive interpolation delay, ms (RemotePlayers samples serverNow − this). */
  interpDelayMs(): number {
    return this.interpDelay;
  }

  /** Interp buffer for a remote player (created lazily) — RemotePlayers samples these. */
  remoteBuffer(playerId: string): InterpBuffer {
    let buffer = this.remoteBuffers.get(playerId);
    if (!buffer) {
      buffer = new InterpBuffer();
      this.remoteBuffers.set(playerId, buffer);
    }
    return buffer;
  }

  // ── Connection ──────────────────────────────────────────────────────────────
  private start(intent: PendingIntent, name: string, character: CharacterId): void {
    this.profile = { name, character };
    this.pending = intent;
    useUIStore.getState().setNetError(undefined);

    if (!this.transport) {
      const transport = createTransport(realtimeUrl());
      this.transport = transport;
      transport.onMessage((msg) => this.handle(msg));
      transport.onBinary((data) => this.handleBinary(data));
      transport.onState((state) => {
        const store = useUIStore.getState();
        if (state === 'open') {
          this.handshake();
        } else if (state === 'connecting') {
          store.setConnectionState('connecting');
        } else if (state === 'reconnecting') {
          store.setConnectionState('reconnecting');
        } else if (state === 'closed') {
          store.setConnectionState('offline');
        }
      });
      transport.connect();
    } else if (this.transport.state === 'open') {
      this.handshake();
    } else {
      this.transport.connect();
    }
  }

  /** (Re)handshake on every socket open: hello, then the pending or resume intent. */
  private handshake(): void {
    const t = this.transport;
    if (!t) return;
    t.send(makeHello(this.profile.name, this.profile.character));
    if (this.pending?.kind === 'create') {
      t.send({ type: 'createSession' });
    } else if (this.pending?.kind === 'join') {
      t.send({ type: 'joinSession', code: this.pending.code });
    } else if (this.joined) {
      // Reconnect: reclaim our playerId via the resume token.
      t.send({ type: 'joinSession', code: this.joined.code, resumeToken: this.joined.resumeToken });
    }
  }

  // ── Binary hot path: snapshots ──────────────────────────────────────────────
  private handleBinary(data: ArrayBuffer): void {
    const snap = decodeSnapshot(data);
    if (!snap) return;
    const { header, entities } = snap;
    const now = performance.now();

    // Clock sync (tick domain): EWMA with outlier rejection — a late packet only ever
    // pulls the offset down, so clamp wild samples instead of chasing them.
    const sample = header.serverTimeMs - now;
    if (this.tickTimeOffset === null) {
      this.tickTimeOffset = sample;
    } else if (Math.abs(sample - this.tickTimeOffset) > 500) {
      this.tickTimeOffset = sample; // genuine clock jump (reconnect/resume)
    } else {
      this.tickTimeOffset += 0.1 * (sample - this.tickTimeOffset);
    }
    netStats.clockOffsetMs = this.tickTimeOffset;

    // Snapshot arrival stats → adaptive interp delay.
    this.trackArrival(now);

    // Local player reconciliation — the header ack block is ours by construction.
    netGame.onAuthoritative(header);

    // Remote entity states: keyframe → new baseline; delta → patch stateless vs baseline.
    if (header.keyframe) {
      const base = new Map<number, RemoteEntityState>();
      for (const rec of entities) base.set(rec.id, recordToState(rec));
      this.baselines.set(header.baselineTick, base);
      // Keep the newest two baselines (a delayed delta may reference the previous one).
      const ticks = [...this.baselines.keys()].sort((a, b) => b - a);
      for (const t of ticks.slice(2)) this.baselines.delete(t);
    }
    const base = this.baselines.get(header.baselineTick);
    if (!base) {
      netStats.unknownBaselines += 1;
      return; // can't resolve deltas — the next keyframe (≤2 s) resyncs
    }
    const patched = new Map<number, DecodedEntityRecord>();
    for (const rec of entities) patched.set(rec.id, rec);

    for (const [id, baseState] of base) {
      const playerId = this.entityOwners.get(id);
      // HP → HUD (own player bar + teammate bars), gated to integer changes so a stable
      // health never spams React. Runs for the local entity too (the ack path carries no HP).
      if (playerId) {
        const hp = Math.round(patched.get(id)?.hp ?? baseState.hp);
        if (this.lastMemberHp.get(id) !== hp) {
          this.lastMemberHp.set(id, hp);
          if (playerId === this.ownPlayerId) useUIStore.getState().setHealth(hp);
          else useUIStore.getState().setMemberHp(playerId, hp);
        }
      }
      if (this.ownEntityId !== null && id === this.ownEntityId) continue; // local: header ack path
      if (!playerId) continue;
      const rec = patched.get(id);
      const state: RemoteEntityState = {
        pos: rec?.pos ?? baseState.pos,
        rotY: rec?.rotY ?? baseState.rotY,
        hp: rec?.hp ?? baseState.hp,
        vel: rec?.vel ?? baseState.vel,
        flags: rec?.flags ?? baseState.flags,
      };
      this.remoteBuffer(playerId).push({
        t: header.serverTimeMs,
        pos: [state.pos[0], state.pos[1], state.pos[2]],
        rotY: state.rotY,
        flags: state.flags,
      });
    }
  }

  private trackArrival(now: number): void {
    netStats.snapshotsReceived += 1;
    if (this.lastSnapshotAt !== null) {
      const gap = now - this.lastSnapshotAt;
      this.arrivalGaps.push(gap);
      if (this.arrivalGaps.length > 64) this.arrivalGaps.shift();
      const rate = 1000 / Math.max(gap, 1);
      netStats.snapshotRateHz += 0.1 * (rate - netStats.snapshotRateHz);

      // Adaptive delay: grow instantly to p95 inter-arrival + margin, shrink slowly.
      const sorted = [...this.arrivalGaps].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
      const target = Math.min(INTERP_DELAY_MAX_MS, Math.max(INTERP_DELAY_MS, p95 * 1.5 + 20));
      if (target > this.interpDelay) {
        this.interpDelay = target;
      } else {
        const dtSec = (now - this.lastDelayUpdateAt) / 1000;
        this.interpDelay = Math.max(target, this.interpDelay - INTERP_DELAY_SHRINK_PER_S * dtSec);
      }
      this.lastDelayUpdateAt = now;
      netStats.interpDelayMs = this.interpDelay;
    }
    this.lastSnapshotAt = now;
  }

  // ── JSON dispatch ───────────────────────────────────────────────────────────
  private handle(msg: ServerMessage): void {
    const store = useUIStore.getState();
    switch (msg.type) {
      case 'welcome': {
        this.pending = null;
        this.joined = { code: msg.session.code, resumeToken: msg.resumeToken };
        this.ownPlayerId = msg.playerId;
        this.syncEntityMap(msg.session.members);
        relicNet.setOwnEntity(this.ownEntityId);
        // Late join / reconnect: reconstruct the live relic (incl. an active flight arc).
        relicNet.fromWelcome(msg.relic);
        store.setRelicCarrier(
          msg.relic?.carrierId !== undefined ? this.entityOwners.get(msg.relic.carrierId) ?? null : null,
        );
        // Seed the wall-clock offset; snapshots take over with tick time.
        if (this.wallOffset === null) {
          this.wallOffset = msg.serverTime - performance.now();
        }
        store.setSession({
          code: msg.session.code,
          playerId: msg.playerId,
          members: msg.session.members.map(toMemberUI),
        });
        store.setConnectionState('connected');
        return;
      }

      case 'playerJoined':
        this.entityOwners.set(msg.member.entityId, msg.member.id);
        store.addSessionMember(toMemberUI(msg.member));
        return;

      case 'playerLeft':
        store.removeSessionMember(msg.playerId);
        this.remoteBuffers.delete(msg.playerId);
        for (const [entityId, owner] of this.entityOwners) {
          if (owner === msg.playerId) this.entityOwners.delete(entityId);
        }
        return;

      case 'sessionState': {
        this.syncEntityMap(msg.members);
        // ~1 Hz roster/ping refresh — the PingCard's data source for OTHER members.
        const ownId = store.session?.playerId;
        const own = store.session?.members.find((m) => m.id === ownId);
        store.setSessionMembers(
          msg.members.map((m) => {
            const ui = toMemberUI(m);
            // Our own ping stays the fresher heartbeat-echoed value.
            if (ui.id === ownId && own?.ping != null) ui.ping = own.ping;
            return ui;
          }),
        );
        return;
      }

      case 'impulse': {
        // Owner copies carry the replay seq; remote shoves arrive via snapshots anyway.
        if (msg.seq !== undefined) netGame.onImpulse(msg.seq, msg.impulse, msg.staggerMs);
        return;
      }

      // ── Phase 4: server-authoritative expedition combat (reliable events) ──────
      case 'zoneChanged': {
        // The party moved zones: switch the prediction sim mode + mirror it to the HUD scene.
        // Authoritative flip — bypasses the store's local-scene guard (server owns the zone).
        netGame.setMode(msg.zone);
        store.setSceneAuthoritative(msg.zone);
        store.setZoneCountdown(null);
        if (msg.zone === 'expedition') store.setHuntFailed(false);
        return;
      }

      case 'zoneCountdown': {
        store.setZoneCountdown(msg.active ? msg.secondsLeft : null);
        return;
      }

      case 'waveStarted': {
        store.setWaveInfo(msg.wave, msg.count);
        return;
      }

      case 'materialTally': {
        // SHARED POOL: the count is server-authoritative — mirror it, never local pickups.
        store.setMaterials(msg.total);
        return;
      }

      case 'playerDowned': {
        if (msg.playerId === this.ownPlayerId) store.setDowned(true);
        return;
      }

      case 'playerRevived': {
        if (msg.playerId === this.ownPlayerId) store.setDowned(false);
        return;
      }

      case 'huntFailed': {
        store.setHuntFailed(true);
        store.setDowned(false);
        return;
      }

      // Monster spawn/despawn + confirmed damage drive the 3D presentation layer (meshes,
      // hitstop, floating numbers). That renderer wiring lands in Phase 6 (needs WebGL/R3F);
      // the server-authoritative gameplay + HUD state above is complete and bot-verified.
      case 'monsterSpawned':
      case 'monsterDespawned':
      case 'damageDealt':
      case 'parrySuccess':
        return;

      // ── Phase 5: relic relay (server-authoritative state machine) ─────────────
      // Maintain the network relic state + re-emit feedback events onto the client bus.
      // The relic's EXISTENCE + grounded phase arrive via the welcome block and the snapshot
      // (kind=relic); these reliable events carry the carrier binding + flight arcs. The 3D
      // relic render + expedition networked loop that CONSUME them land in Phase 6 (WebGL/R3F).
      case 'relicLaunched':
        relicNet.onLaunched(msg);
        store.setRelicCarrier(null); // in flight — nobody holds it
        return;
      case 'relicCaught':
        relicNet.onCaught(msg);
        store.setRelicCarrier(this.entityOwners.get(msg.carrierId) ?? null);
        return;
      case 'relicPassFailed':
        relicNet.onPassFailed(msg);
        return;
      case 'relicDropped':
        relicNet.onDropped(msg);
        store.setRelicCarrier(null);
        return;
      case 'relicGrounded':
        relicNet.onGrounded(msg);
        store.setRelicCarrier(null);
        return;
      case 'passRejected':
        // The thrower's provisional local flight snaps back with the existing fail feedback.
        // Wired to the throw-prediction UI in Phase 6; the reason is the server's word.
        return;

      case 'ping': {
        this.transport?.send({ type: 'pong', t: msg.t });
        // Own ping display updates on EVERY heartbeat (spec: "from every pong").
        if (msg.yourPing !== null) {
          store.setOwnPing(Math.round(msg.yourPing));
          netStats.pingMs = msg.yourPing;
        }
        // Wall-clock sync EWMA (pre-snapshot fallback only).
        const halfRtt = (msg.yourPing ?? 0) / 2;
        const sample = msg.t + halfRtt - performance.now();
        this.wallOffset =
          this.wallOffset === null
            ? sample
            : this.wallOffset + PING_EWMA_ALPHA * (sample - this.wallOffset);
        return;
      }

      case 'error': {
        if (msg.code === 'unknown_session' || msg.code === 'session_full' || msg.code === 'server_full') {
          this.pending = null;
          // A failed RESUME means the session died while we were away (past the grace window).
          // Fall out to the menu gracefully with a rejoin-by-code hint instead of freezing.
          if (this.joined) {
            this.joined = null;
            this.disconnect(); // stops reconnect + clears session state (also clears netError)
            store.setScreen('menu');
            store.setNetError('Session ended while you were disconnected — rejoin with the code.');
            return;
          }
        }
        store.setNetError(friendlyError(msg.code, msg.message));
        return;
      }
    }
  }

  private syncEntityMap(members: SessionMemberInfo[]): void {
    for (const m of members) {
      this.entityOwners.set(m.entityId, m.id);
      if (m.id === this.ownPlayerId) this.ownEntityId = m.entityId;
    }
  }
}

/** Player-facing copy for the join/connect error codes (Phase 6 Task 1 friendly errors). */
const friendlyError = (code: string, fallback: string): string => {
  switch (code) {
    case 'unknown_session':
      return 'No party found with that code.';
    case 'session_full':
      return 'That party is full (4 players).';
    case 'server_full':
      return 'The server is busy right now — try again in a moment.';
    case 'version_mismatch':
      return 'Update available — refresh the page to get the latest version.';
    default:
      return fallback;
  }
};

/** Sanity-check a wire character string into a renderable id. */
export const characterIdOf = (raw: string): CharacterId =>
  isCharacterId(raw) ? raw : DEFAULT_CHARACTER_ID;

/** The client-singleton session connection (one per tab, like the ECS world). */
export const netClient = new NetClient();

// Dev-only inspection handle (console/tooling): lets a headless harness verify the remote
// data path (entityOwners, remoteBuffers) even when the R3F canvas can't mount.
if (import.meta.env.DEV) (window as unknown as { __netClient?: unknown }).__netClient = netClient;

const recordToState = (rec: DecodedEntityRecord): RemoteEntityState => ({
  pos: rec.pos ?? [0, 0, 0],
  rotY: rec.rotY ?? 0,
  hp: rec.hp ?? 0,
  vel: rec.vel ?? [0, 0, 0],
  flags: rec.flags ?? 0,
});
