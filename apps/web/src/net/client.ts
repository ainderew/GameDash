import { InterpBuffer } from '@sim/interp';
import type { ServerMessage, SessionMemberInfo } from '@shared/net/messages';
import { makeHello } from '@shared/net/messages';
import {
  ANIM_FLAG_AIRBORNE,
  ANIM_FLAG_SPRINT,
  PING_EWMA_ALPHA,
  TRANSFORM_RELAY_HZ,
} from '@shared/net/constants';
import { heightAt } from '@sim/terrain/terrainHeight';
import { localPlayers } from '@/game/ecs/world';
import { useUIStore, type SessionMemberUI } from '@/ui/store';
import { realtimeUrl, WebSocketTransport, type Transport } from '@/net/transport';

/**
 * THE session client: connection state machine (idle → connecting → joined), message
 * dispatch, clock-sync EWMA, the remote-transform interpolation registry, and the
 * TEMPORARY 15 Hz local-transform publisher (Phase 3 replaces publishing with binary
 * InputCmds; everything else here survives).
 *
 * Doctrine split: session/roster/ping → zustand (UI, inherently ≤1 Hz updates);
 * remote TRANSFORMS → interp buffers read by the render loop (never React state).
 */

type PendingIntent =
  | { kind: 'create' }
  | { kind: 'join'; code: string }
  | { kind: 'resume'; code: string; resumeToken: string };

const toMemberUI = (m: SessionMemberInfo): SessionMemberUI => ({
  id: m.id,
  name: m.name,
  character: m.character,
  ping: m.ping,
  connected: m.connected,
});

class NetClient {
  private transport: Transport | null = null;
  private profile = { name: 'Adventurer', character: 'hero' };
  private pending: PendingIntent | null = null;
  /** Set once joined — reused to resume across reconnects. */
  private joined: { code: string; resumeToken: string } | null = null;

  /** serverTime(ms) − performance.now() EWMA — remote timelines sample through this. */
  private serverTimeOffset: number | null = null;

  /** Per-remote-player snapshot buffers, keyed by PlayerId. */
  private readonly remoteBuffers = new Map<string, InterpBuffer>();

  private publishTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public API (used by useSession / MainMenu) ─────────────────────────────
  createSession(name: string, character: string): void {
    this.start({ kind: 'create' }, name, character);
  }

  joinSession(code: string, name: string, character: string): void {
    this.start({ kind: 'join', code }, name, character);
  }

  leaveSession(): void {
    this.transport?.send({ type: 'leaveSession' });
    this.disconnect();
  }

  disconnect(): void {
    this.stopPublishing();
    this.transport?.close();
    this.transport = null;
    this.pending = null;
    this.joined = null;
    this.remoteBuffers.clear();
    const store = useUIStore.getState();
    store.setSession(undefined);
    store.setConnectionState('offline');
  }

  /** Estimated server wall-clock "now", ms. Falls back to local time before sync. */
  serverNow(): number {
    return this.serverTimeOffset === null
      ? Date.now()
      : performance.now() + this.serverTimeOffset;
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
  private start(intent: PendingIntent, name: string, character: string): void {
    this.profile = { name, character };
    this.pending = intent;
    useUIStore.getState().setNetError(undefined);

    if (!this.transport) {
      const transport = new WebSocketTransport(realtimeUrl());
      this.transport = transport;
      transport.onMessage((msg) => this.handle(msg));
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

  // ── Dispatch ────────────────────────────────────────────────────────────────
  private handle(msg: ServerMessage): void {
    const store = useUIStore.getState();
    switch (msg.type) {
      case 'welcome': {
        this.pending = null;
        this.joined = { code: msg.session.code, resumeToken: msg.resumeToken };
        // Seed the clock offset; heartbeats refine it (RTT correction included there).
        if (this.serverTimeOffset === null) {
          this.serverTimeOffset = msg.serverTime - performance.now();
        }
        store.setSession({
          code: msg.session.code,
          playerId: msg.playerId,
          members: msg.session.members.map(toMemberUI),
        });
        store.setConnectionState('connected');
        this.startPublishing();
        return;
      }

      case 'playerJoined':
        store.addSessionMember(toMemberUI(msg.member));
        return;

      case 'playerLeft':
        store.removeSessionMember(msg.playerId);
        this.remoteBuffers.delete(msg.playerId);
        return;

      case 'sessionState': {
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

      case 'transformBatch':
        // TEMPORARY Phase 2 relay input — feeds the interpolation buffers.
        for (const tf of msg.transforms) {
          this.remoteBuffer(tf.id).push({ t: tf.t, pos: tf.p, rotY: tf.r, flags: tf.a });
        }
        return;

      case 'ping': {
        this.transport?.send({ type: 'pong', t: msg.t });
        // Own ping display updates on EVERY heartbeat (spec: "from every pong").
        if (msg.yourPing !== null) store.setOwnPing(Math.round(msg.yourPing));
        // Clock sync EWMA: server stamped t at send; it is ~halfRtt old on arrival.
        const halfRtt = (msg.yourPing ?? 0) / 2;
        const sample = msg.t + halfRtt - performance.now();
        this.serverTimeOffset =
          this.serverTimeOffset === null
            ? sample
            : this.serverTimeOffset + PING_EWMA_ALPHA * (sample - this.serverTimeOffset);
        return;
      }

      case 'error': {
        if (msg.code === 'unknown_session' || msg.code === 'session_full') {
          this.pending = null;
          // A failed RESUME means the session died while we were away.
          if (this.joined) {
            this.joined = null;
            store.setSession(undefined);
          }
        }
        store.setNetError(msg.message);
        return;
      }
    }
  }

  // ── TEMPORARY Phase 2: 15 Hz local transform publisher (Phase 3: InputCmds) ──
  private startPublishing(): void {
    if (this.publishTimer) return;
    this.publishTimer = setInterval(() => {
      const store = useUIStore.getState();
      if (store.scene !== 'hub' || store.screen !== 'playing') return;
      const player = localPlayers.first;
      if (!player?.transform || !player.velocity) return;
      const [x, y, z] = player.transform.position;
      const speed = Math.hypot(player.velocity.linear[0], player.velocity.linear[2]);
      let flags = 0;
      if (speed > 4.4) flags |= ANIM_FLAG_SPRINT;
      if (y > heightAt(x, z) + 0.06) flags |= ANIM_FLAG_AIRBORNE;
      this.transport?.send({ type: 'transformUpdate', p: [x, y, z], r: player.transform.rotationY, a: flags });
    }, 1000 / TRANSFORM_RELAY_HZ);
  }

  private stopPublishing(): void {
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.publishTimer = null;
  }
}

/** The client-singleton session connection (one per tab, like the ECS world). */
export const netClient = new NetClient();
