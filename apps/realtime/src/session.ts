import type { PlayerId } from '@shared/types';
import type { ServerMessage, SessionMemberInfo } from '@shared/net/messages';
import {
  generatePlayerId,
  generateResumeToken,
  generateSessionCode,
} from '@shared/net/ids';
import {
  RESUME_WINDOW_MS,
  SESSION_GC_GRACE_MS,
  SESSION_MAX_PLAYERS,
} from '@shared/net/constants';
import { logger, type Logger } from './log';

/**
 * Session model: a party of ≤4 players behind a 6-char join code. Transport-agnostic —
 * players hold a `PeerLink` (send-only), so unit tests drive sessions with fakes and
 * the ws layer stays in connection.ts/index.ts.
 *
 * NOTE (Phase 2): sessions do NOT run stepSim yet — hub presence is a clamped transform
 * relay (see relay.ts). Phase 3 gives each session a GameWorld + fixed 30 Hz loop.
 */

export interface PeerLink {
  send(msg: ServerMessage): void;
}

/** TEMPORARY (Phase 2 relay): last accepted transform + dirty flag for the 15 Hz flush. */
export interface RelayTransform {
  p: [number, number, number];
  r: number;
  a: number;
  /** Server wall-clock ms at acceptance — becomes the interp timeline stamp. */
  t: number;
  dirty: boolean;
}

export interface SessionPlayer {
  id: PlayerId;
  name: string;
  character: string;
  resumeToken: string;
  link: PeerLink;
  /** EWMA RTT, ms. Null until the first heartbeat round-trip. */
  pingMs: number | null;
  transform: RelayTransform | null;
  joinedAt: number;
}

interface DepartedPlayer {
  id: PlayerId;
  name: string;
  character: string;
  resumeToken: string;
  leftAt: number;
}

export class Session {
  readonly players = new Map<PlayerId, SessionPlayer>();
  /** Recently disconnected members, keyed by resumeToken (reconnect keeps playerId). */
  readonly departed = new Map<string, DepartedPlayer>();
  /** Set when the last player leaves; sessions are GC'd after the grace window. */
  emptySince: number | null = null;

  constructor(
    readonly code: string,
    readonly createdAt: number,
  ) {}

  memberInfos(): SessionMemberInfo[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      ping: p.pingMs,
      connected: true,
    }));
  }

  broadcast(msg: ServerMessage, exceptId?: PlayerId): void {
    for (const player of this.players.values()) {
      if (player.id === exceptId) continue;
      player.link.send(msg);
    }
  }
}

export interface PlayerProfile {
  name: string;
  character: string;
}

export type JoinResult =
  | { ok: true; session: Session; player: SessionPlayer; resumed: boolean }
  | { ok: false; error: 'unknown_session' | 'session_full' };

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: Logger = logger,
  ) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.players.size;
    return n;
  }

  getSession(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  /** All live sessions — the relay/roster flush loops iterate this. */
  allSessions(): IterableIterator<Session> {
    return this.sessions.values();
  }

  createSession(profile: PlayerProfile, link: PeerLink): { session: Session; player: SessionPlayer } {
    let code = generateSessionCode();
    while (this.sessions.has(code)) code = generateSessionCode(); // collision paranoia
    const session = new Session(code, this.now());
    this.sessions.set(code, session);
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_created', { code, playerId: player.id, name: player.name });
    return { session, player };
  }

  joinSession(code: string, profile: PlayerProfile, link: PeerLink, resumeToken?: string): JoinResult {
    const session = this.sessions.get(code);
    if (!session) return { ok: false, error: 'unknown_session' };

    // Resume path: a valid token within the window reclaims the departed playerId.
    if (resumeToken) {
      const departed = session.departed.get(resumeToken);
      if (departed && this.now() - departed.leftAt <= RESUME_WINDOW_MS) {
        session.departed.delete(resumeToken);
        if (session.players.size >= SESSION_MAX_PLAYERS) return { ok: false, error: 'session_full' };
        const player = this.attach(session, profile, link, departed.id, resumeToken);
        this.log.info('session_resumed', { code, playerId: player.id });
        return { ok: true, session, player, resumed: true };
      }
    }

    if (session.players.size >= SESSION_MAX_PLAYERS) return { ok: false, error: 'session_full' };
    const player = this.attach(session, profile, link, generatePlayerId());
    this.log.info('session_joined', { code, playerId: player.id, name: player.name, players: session.players.size });
    return { ok: true, session, player, resumed: false };
  }

  private attach(
    session: Session,
    profile: PlayerProfile,
    link: PeerLink,
    id: PlayerId,
    resumeToken = generateResumeToken(),
  ): SessionPlayer {
    const player: SessionPlayer = {
      id,
      name: profile.name,
      character: profile.character,
      resumeToken,
      link,
      pingMs: null,
      transform: null,
      joinedAt: this.now(),
    };
    session.players.set(player.id, player);
    session.emptySince = null;
    // Announce to the OTHERS — the joiner gets the full roster in its welcome.
    session.broadcast(
      {
        type: 'playerJoined',
        member: { id: player.id, name: player.name, character: player.character, ping: null, connected: true },
      },
      player.id,
    );
    return player;
  }

  removePlayer(session: Session, playerId: PlayerId, reason: 'left' | 'disconnected'): void {
    const player = session.players.get(playerId);
    if (!player) return;
    session.players.delete(playerId);
    session.departed.set(player.resumeToken, {
      id: player.id,
      name: player.name,
      character: player.character,
      resumeToken: player.resumeToken,
      leftAt: this.now(),
    });
    session.broadcast({ type: 'playerLeft', playerId, reason });
    if (session.players.size === 0) session.emptySince = this.now();
    this.log.info('session_left', { code: session.code, playerId, reason, players: session.players.size });
  }

  /** Drop sessions that have been empty past the grace window. Returns removed count. */
  gcSweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [code, session] of this.sessions) {
      if (session.emptySince !== null && now - session.emptySince >= SESSION_GC_GRACE_MS) {
        this.sessions.delete(code);
        removed += 1;
        this.log.info('session_gc', { code, ageMs: now - session.createdAt });
      }
      // Expire stale resume tokens regardless.
      for (const [token, departed] of session.departed) {
        if (now - departed.leftAt > RESUME_WINDOW_MS) session.departed.delete(token);
      }
    }
    return removed;
  }
}
