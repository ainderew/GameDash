import {
  clientMessageSchema,
  type ClientMessage,
  type NetErrorCode,
  type ServerMessage,
} from '@shared/net/messages';
import { normalizeSessionCode } from '@shared/net/ids';
import {
  MAX_BYTES_PER_WINDOW,
  MAX_MSGS_PER_WINDOW,
  PING_EWMA_ALPHA,
  PROTOCOL_VERSION,
  RATE_LIMIT_ABUSE_WINDOWS,
  RATE_LIMIT_WINDOW_MS,
} from '@shared/net/constants';
import { decodeInputPacket, MSG_INPUT } from '@shared/net/input';
import type { CharacterId } from '@shared/net/character';
import { logger, type Logger } from './log';
import type { PeerLink, Session, SessionManager, SessionPlayer } from './session';

/**
 * Per-socket protocol handler: hello/version handshake → session attach → message
 * dispatch. Transport-thin — takes any `SocketLike`, so unit tests drive it with fakes
 * while index.ts binds it to real ws sockets. Every inbound JSON frame is zod-validated
 * and every binary frame length-validated; malformed traffic is answered with an `error`
 * (JSON) or silently dropped (binary hot path) and the connection SURVIVES (a buggy or
 * hostile client must never crash the room).
 *
 * Phase 3: clients may send exactly ONE binary frame type — MSG_INPUT (intent). There is
 * NO message that carries a client transform; state only ever flows server → client.
 */

export interface SocketLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

/** ws close code for protocol violations we refuse to serve (version mismatch). */
const CLOSE_UNSUPPORTED = 4400;
/** ws close code for a peer force-dropped for sustained rate-limit abuse. */
const CLOSE_POLICY = 4408;

type Phase = 'awaitingHello' | 'ready' | 'inSession' | 'closed';

export class ClientConnection implements PeerLink {
  private phase: Phase = 'awaitingHello';
  private profile: { name: string; character: CharacterId } | null = null;
  session: Session | null = null;
  player: SessionPlayer | null = null;

  /** Set when a ping goes out; a pong echoing an older stamp still yields a valid RTT. */
  lastPongAt: number;

  // ── Per-connection rate limiting (fixed 1 s window; Phase 6 Task 3) ──────────
  private rlWindowStart: number;
  private rlMsgs = 0;
  private rlBytes = 0;
  private rlWindowAbusive = false;
  private rlConsecutiveAbusive = 0;

  constructor(
    private readonly socket: SocketLike,
    private readonly manager: SessionManager,
    private readonly now: () => number = Date.now,
    private readonly log: Logger = logger,
  ) {
    this.lastPongAt = this.now();
    this.rlWindowStart = this.now();
  }

  /**
   * Meter one inbound frame against the fixed 1 s window. Returns false when the frame must
   * be dropped (over the msgs/s or bytes/s cap this window); the excess is discarded but the
   * connection survives. Only SUSTAINED abuse — every window over cap for
   * RATE_LIMIT_ABUSE_WINDOWS in a row — force-closes the socket. A buggy/hostile client can
   * never spend the room's CPU beyond the cap.
   */
  private admit(bytes: number): boolean {
    const now = this.now();
    if (now - this.rlWindowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rlConsecutiveAbusive = this.rlWindowAbusive ? this.rlConsecutiveAbusive + 1 : 0;
      if (this.rlConsecutiveAbusive >= RATE_LIMIT_ABUSE_WINDOWS) {
        this.log.warn('rate_limit_abuse', { playerId: this.player?.id });
        this.socket.close(CLOSE_POLICY, 'rate limit exceeded');
        this.phase = 'closed';
        this.detachFromSession('disconnected');
        return false;
      }
      this.rlWindowStart = now;
      this.rlMsgs = 0;
      this.rlBytes = 0;
      this.rlWindowAbusive = false;
    }
    this.rlMsgs += 1;
    this.rlBytes += bytes;
    const over = this.rlMsgs > MAX_MSGS_PER_WINDOW || this.rlBytes > MAX_BYTES_PER_WINDOW;
    if (over) this.rlWindowAbusive = true;
    return !over;
  }

  // ── PeerLink ────────────────────────────────────────────────────────────────
  send(msg: ServerMessage): void {
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // Socket already dying — the close handler cleans up.
    }
  }

  sendBinary(data: ArrayBuffer): void {
    try {
      this.socket.send(data);
    } catch {
      // Socket already dying — the close handler cleans up.
    }
  }

  // ── Inbound: binary hot path (InputCmds) ────────────────────────────────────
  /**
   * Binary frames carry ONLY input packets. Malformed/unexpected binary is dropped
   * without a reply — answering a 30 Hz hot path with JSON errors would amplify abuse.
   */
  handleBinary(data: ArrayBufferLike): void {
    if (this.phase !== 'inSession' || !this.player) return;
    if (!this.admit(data.byteLength)) return;
    const view = new DataView(data);
    if (view.byteLength < 1 || view.getUint8(0) !== MSG_INPUT) return;
    const cmds = decodeInputPacket(data);
    if (!cmds) return;
    const now = this.now();
    for (const cmd of cmds) this.player.input.offer(cmd, now);
    // Input is the "player is here and playing" signal that keeps idle-GC at bay.
    this.session?.markActivity(now);
  }

  // ── Inbound: JSON control channel ───────────────────────────────────────────
  handleRaw(raw: unknown): void {
    if (this.phase === 'closed') return;
    const size = typeof raw === 'string' ? raw.length : String(raw).length;
    if (!this.admit(size)) return;

    let json: unknown;
    try {
      json = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this.protocolError('bad_message', 'frame is not valid JSON');
      return;
    }

    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.protocolError('bad_message', 'message failed schema validation');
      return;
    }
    this.handle(parsed.data);
  }

  private handle(msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello': {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.log.warn('version_mismatch', { got: msg.protocolVersion, want: PROTOCOL_VERSION });
          this.sendError('version_mismatch', `server speaks protocol v${PROTOCOL_VERSION}`);
          this.socket.close(CLOSE_UNSUPPORTED, 'version mismatch');
          this.phase = 'closed';
          return;
        }
        this.profile = { name: msg.name, character: msg.character };
        if (this.phase === 'awaitingHello') this.phase = 'ready';
        return;
      }

      case 'createSession': {
        if (!this.requireReadyNoSession()) return;
        if (this.manager.atCapacity) {
          this.sendError('server_full', 'the server is at capacity — try again shortly');
          return;
        }
        const { session, player } = this.manager.createSession(this.profile!, this);
        this.enterSession(session, player);
        return;
      }

      case 'joinSession': {
        if (!this.requireReadyNoSession()) return;
        const result = this.manager.joinSession(
          normalizeSessionCode(msg.code),
          this.profile!,
          this,
          msg.resumeToken,
        );
        if (!result.ok) {
          this.sendError(result.error, result.error === 'session_full' ? 'session is full (4 players)' : 'no session with that code');
          return;
        }
        this.enterSession(result.session, result.player);
        return;
      }

      case 'leaveSession': {
        this.detachFromSession('left');
        return;
      }

      case 'requestZoneCountdown': {
        this.session?.startExpeditionCountdown();
        return;
      }

      case 'cancelZoneCountdown': {
        this.session?.cancelCountdown();
        return;
      }

      case 'returnToHub': {
        this.session?.returnToHub();
        return;
      }

      case 'pong': {
        const now = this.now();
        this.lastPongAt = now;
        const rtt = Math.max(0, now - msg.t);
        if (this.player) {
          this.player.pingMs =
            this.player.pingMs === null
              ? rtt
              : this.player.pingMs + PING_EWMA_ALPHA * (rtt - this.player.pingMs);
        }
        return;
      }
    }
  }

  // ── Heartbeat (driven by index.ts's 2 s interval) ──────────────────────────
  sendHeartbeat(): void {
    if (this.phase === 'closed') return;
    this.send({ type: 'ping', t: this.now(), yourPing: this.player?.pingMs ?? null });
  }

  /** True when the peer stopped answering pings and should be dropped. */
  isStale(timeoutMs: number): boolean {
    return this.now() - this.lastPongAt > timeoutMs;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  handleClose(): void {
    if (this.phase === 'closed') {
      this.detachFromSession('disconnected');
      return;
    }
    this.phase = 'closed';
    this.detachFromSession('disconnected');
  }

  private enterSession(session: Session, player: SessionPlayer): void {
    this.session = session;
    this.player = player;
    this.phase = 'inSession';
    this.send({
      type: 'welcome',
      playerId: player.id,
      resumeToken: player.resumeToken,
      session: { code: session.code, members: session.memberInfos() },
      serverTime: this.now(),
      relic: session.relicWelcome(),
      monsters: session.monsterRoster(),
    });
  }

  private detachFromSession(reason: 'left' | 'disconnected'): void {
    if (this.session && this.player) {
      this.manager.removePlayer(this.session, this.player.id, reason);
      this.session = null;
      this.player = null;
      if (this.phase !== 'closed') this.phase = 'ready';
    }
  }

  private requireReadyNoSession(): boolean {
    if (!this.profile) {
      this.sendError('hello_required', 'send hello before session commands');
      return false;
    }
    if (this.session) {
      this.sendError('already_in_session', 'leave the current session first');
      return false;
    }
    return true;
  }

  private sendError(code: NetErrorCode, message: string): void {
    this.send({ type: 'error', code, message });
  }

  private protocolError(code: NetErrorCode, message: string): void {
    this.log.warn('bad_message', { message, playerId: this.player?.id });
    this.sendError(code, message);
  }
}
