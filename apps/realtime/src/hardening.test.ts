import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { PROTOCOL_VERSION, RATE_LIMIT_ABUSE_WINDOWS } from '@shared/net/constants';
import { SessionManager } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { silentLogger } from './log';

/**
 * Phase 6 Task 3 server hardening: per-connection rate limits, the MAX_SESSIONS cap, idle
 * session GC, and panic-safe room isolation (one room's exception can never take down the
 * process or a sibling room).
 */

class FakeSocket implements SocketLike {
  sent: ServerMessage[] = [];
  binary: ArrayBuffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as ServerMessage);
    else this.binary.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

const hello = JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Tester', character: 'hero' });

const makeHarness = (opts: { maxSessions?: number; idleTimeoutMs?: number } = {}) => {
  let t = 5_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const manager = new SessionManager({ now: clock.now, log: silentLogger, ...opts });
  const connect = () => {
    const socket = new FakeSocket();
    const conn = new ClientConnection(socket, manager, clock.now, silentLogger);
    return { socket, conn };
  };
  return { manager, clock, connect };
};

const inSession = (connect: () => { socket: FakeSocket; conn: ClientConnection }) => {
  const c = connect();
  c.conn.handleRaw(hello);
  c.conn.handleRaw(JSON.stringify({ type: 'createSession' }));
  return c;
};

describe('per-connection rate limiting', () => {
  it('force-closes a socket that floods every window past the cap (4408)', () => {
    const { connect, clock } = makeHarness();
    const { socket, conn } = inSession(connect);
    // Flood well past the msgs/window cap for more than the abuse-window streak.
    for (let w = 0; w < RATE_LIMIT_ABUSE_WINDOWS + 2; w += 1) {
      for (let i = 0; i < 400; i += 1) conn.handleRaw(JSON.stringify({ type: 'pong', t: 1 }));
      clock.advance(1001); // roll the window
    }
    expect(socket.closed?.code).toBe(4408);
  });

  it('a burst that stays under the cap never trips the limiter', () => {
    const { connect, clock } = makeHarness();
    const { socket, conn } = inSession(connect);
    for (let w = 0; w < 10; w += 1) {
      for (let i = 0; i < 100; i += 1) conn.handleRaw(JSON.stringify({ type: 'pong', t: 1 }));
      clock.advance(1001);
    }
    expect(socket.closed).toBeNull();
  });
});

describe('MAX_SESSIONS cap', () => {
  it('refuses createSession past the cap with server_full and keeps the connection', () => {
    const { manager, connect } = makeHarness({ maxSessions: 2 });
    inSession(connect);
    inSession(connect);
    expect(manager.sessionCount).toBe(2);
    expect(manager.atCapacity).toBe(true);

    const third = connect();
    third.conn.handleRaw(hello);
    third.conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    expect(third.socket.ofType('error')[0]?.code).toBe('server_full');
    expect(third.socket.closed).toBeNull();
    expect(manager.sessionCount).toBe(2);
  });
});

describe('idle session GC', () => {
  it('reaps a populated but silent session past the idle timeout, notifying its clients', () => {
    const { manager, clock, connect } = makeHarness({ idleTimeoutMs: 30_000 });
    const { socket } = inSession(connect);
    expect(manager.sessionCount).toBe(1);

    clock.advance(29_000);
    manager.gcSweep();
    expect(manager.sessionCount).toBe(1); // still within the idle window

    clock.advance(2_000);
    manager.gcSweep();
    expect(manager.sessionCount).toBe(0);
    expect(socket.ofType('error').some((e) => e.code === 'not_in_session')).toBe(true);
  });

  it('input activity resets the idle timer', () => {
    const { manager, clock, connect } = makeHarness({ idleTimeoutMs: 30_000 });
    const { conn } = inSession(connect);
    clock.advance(29_000);
    conn.session!.markActivity(clock.now()); // an input frame just arrived
    clock.advance(29_000);
    manager.gcSweep();
    expect(manager.sessionCount).toBe(1);
  });
});

describe('panic-safe room isolation', () => {
  it('a room that throws in its tick is torn down alone; sibling rooms keep running', () => {
    const { manager, connect } = makeHarness();
    const good = inSession(connect);
    const bad = inSession(connect);
    const goodCode = good.socket.ofType('welcome')[0]!.session.code;
    const badCode = bad.socket.ofType('welcome')[0]!.session.code;

    // Poison the bad room's tick.
    const badSession = manager.getSession(badCode)!;
    badSession.step = () => {
      throw new Error('boom');
    };

    expect(() => manager.stepAll(1 / 30)).not.toThrow();
    expect(manager.getSession(badCode)).toBeUndefined();
    expect(bad.socket.ofType('error').some((e) => e.message.includes('internal_error'))).toBe(true);
    // The healthy room is untouched and still live.
    expect(manager.getSession(goodCode)).toBeDefined();
  });
});
