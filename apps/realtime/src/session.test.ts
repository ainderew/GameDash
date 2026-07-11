import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { SESSION_GC_GRACE_MS } from '@shared/net/constants';
import { SessionManager, type PeerLink } from './session';
import { silentLogger } from './log';

class FakeLink implements PeerLink {
  messages: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.messages.push(msg);
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.messages.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

const profile = (name: string) => ({ name, character: 'hero' });

const makeManager = () => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const manager = new SessionManager(clock.now, silentLogger);
  return { manager, clock };
};

describe('SessionManager', () => {
  it('creates a session with a well-formed 6-char code and the creator attached', () => {
    const { manager } = makeManager();
    const link = new FakeLink();
    const { session, player } = manager.createSession(profile('Ana'), link);
    expect(session.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    expect(session.players.get(player.id)?.name).toBe('Ana');
    expect(manager.sessionCount).toBe(1);
  });

  it('join by code attaches and announces playerJoined to existing members only', () => {
    const { manager } = makeManager();
    const a = new FakeLink();
    const b = new FakeLink();
    const { session } = manager.createSession(profile('Ana'), a);
    const result = manager.joinSession(session.code, profile('Ben'), b);
    expect(result.ok).toBe(true);
    expect(session.players.size).toBe(2);
    expect(a.ofType('playerJoined')).toHaveLength(1);
    expect(a.ofType('playerJoined')[0]!.member.name).toBe('Ben');
    expect(b.ofType('playerJoined')).toHaveLength(0); // joiner learns via welcome, not echo
  });

  it('rejects a bad code with unknown_session', () => {
    const { manager } = makeManager();
    const result = manager.joinSession('ZZZZZZ', profile('Ben'), new FakeLink());
    expect(result).toEqual({ ok: false, error: 'unknown_session' });
  });

  it('rejects the 5th player with session_full', () => {
    const { manager } = makeManager();
    const { session } = manager.createSession(profile('P1'), new FakeLink());
    for (let i = 2; i <= 4; i += 1) {
      expect(manager.joinSession(session.code, profile(`P${i}`), new FakeLink()).ok).toBe(true);
    }
    const fifth = manager.joinSession(session.code, profile('P5'), new FakeLink());
    expect(fifth).toEqual({ ok: false, error: 'session_full' });
    expect(session.players.size).toBe(4);
  });

  it('leave broadcasts playerLeft and marks the session empty', () => {
    const { manager } = makeManager();
    const a = new FakeLink();
    const b = new FakeLink();
    const { session, player: ana } = manager.createSession(profile('Ana'), a);
    manager.joinSession(session.code, profile('Ben'), b);
    manager.removePlayer(session, ana.id, 'disconnected');
    expect(b.ofType('playerLeft')).toHaveLength(1);
    expect(b.ofType('playerLeft')[0]).toMatchObject({ playerId: ana.id, reason: 'disconnected' });
    expect(session.emptySince).toBeNull(); // Ben still in
    const ben = [...session.players.values()][0]!;
    manager.removePlayer(session, ben.id, 'left');
    expect(session.emptySince).not.toBeNull();
  });

  it('GCs empty sessions only after the grace window', () => {
    const { manager, clock } = makeManager();
    const link = new FakeLink();
    const { session, player } = manager.createSession(profile('Ana'), link);
    manager.removePlayer(session, player.id, 'disconnected');
    clock.advance(SESSION_GC_GRACE_MS - 1);
    expect(manager.gcSweep()).toBe(0);
    expect(manager.getSession(session.code)).toBeDefined();
    clock.advance(2);
    expect(manager.gcSweep()).toBe(1);
    expect(manager.getSession(session.code)).toBeUndefined();
  });

  it('resumeToken rejoin reclaims the same playerId within the window', () => {
    const { manager, clock } = makeManager();
    const a = new FakeLink();
    const { session, player } = manager.createSession(profile('Ana'), a);
    const { id, resumeToken } = player;
    manager.removePlayer(session, id, 'disconnected');
    clock.advance(5000);
    const rejoin = manager.joinSession(session.code, profile('Ana'), new FakeLink(), resumeToken);
    expect(rejoin.ok).toBe(true);
    if (rejoin.ok) {
      expect(rejoin.player.id).toBe(id);
      expect(rejoin.resumed).toBe(true);
    }
  });

  it('a stale or bogus resumeToken falls back to a fresh join with a new id', () => {
    const { manager } = makeManager();
    const { session, player } = manager.createSession(profile('Ana'), new FakeLink());
    const rejoin = manager.joinSession(session.code, profile('Ben'), new FakeLink(), 'rt_bogus');
    expect(rejoin.ok).toBe(true);
    if (rejoin.ok) {
      expect(rejoin.player.id).not.toBe(player.id);
      expect(rejoin.resumed).toBe(false);
    }
  });
});
