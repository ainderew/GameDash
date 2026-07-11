import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { HUB_BOUNDS_RADIUS, PROTOCOL_VERSION, RELAY_MAX_SPEED, RELAY_SPEED_TOLERANCE } from '@shared/net/constants';
import { SessionManager } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { clampRelayTransform, flushTransforms } from './relay';
import { silentLogger } from './log';

class FakeSocket implements SocketLike {
  sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

const makeHarness = () => {
  let t = 5_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const manager = new SessionManager(clock.now, silentLogger);
  const connect = () => {
    const socket = new FakeSocket();
    const conn = new ClientConnection(socket, manager, clock.now, silentLogger);
    return { socket, conn };
  };
  return { manager, clock, connect };
};

const hello = (version = PROTOCOL_VERSION) =>
  JSON.stringify({ type: 'hello', protocolVersion: version, name: 'Tester', character: 'hero' });

describe('ClientConnection handshake', () => {
  it('rejects a protocol version mismatch with an error and closes', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello(PROTOCOL_VERSION + 1));
    expect(socket.ofType('error')[0]?.code).toBe('version_mismatch');
    expect(socket.closed?.code).toBe(4400);
  });

  it('requires hello before session commands', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    expect(socket.ofType('error')[0]?.code).toBe('hello_required');
    expect(socket.closed).toBeNull(); // connection preserved
  });

  it('hello → createSession yields a welcome with playerId, resumeToken, code, roster', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    const welcome = socket.ofType('welcome')[0]!;
    expect(welcome.playerId).toMatch(/^p_/);
    expect(welcome.resumeToken).toMatch(/^rt_/);
    expect(welcome.session.code).toHaveLength(6);
    expect(welcome.session.members).toHaveLength(1);
    expect(typeof welcome.serverTime).toBe('number');
  });

  it('joinSession with a wrong code answers unknown_session and keeps the connection', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'joinSession', code: 'NOPE22' }));
    expect(socket.ofType('error')[0]?.code).toBe('unknown_session');
    expect(socket.closed).toBeNull();
  });

  it('lowercases/whitespace in the code are normalized before lookup', () => {
    const { connect } = makeHarness();
    const a = connect();
    a.conn.handleRaw(hello());
    a.conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    const code = a.socket.ofType('welcome')[0]!.session.code;
    const b = connect();
    b.conn.handleRaw(hello());
    b.conn.handleRaw(JSON.stringify({ type: 'joinSession', code: `  ${code.toLowerCase()} ` }));
    expect(b.socket.ofType('welcome')).toHaveLength(1);
  });
});

describe('ClientConnection resilience (malformed messages)', () => {
  it('survives invalid JSON: error reply, no crash, socket open', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw('{not json!!');
    expect(socket.ofType('error')[0]?.code).toBe('bad_message');
    expect(socket.closed).toBeNull();
    // Still fully functional afterwards.
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    expect(socket.ofType('welcome')).toHaveLength(1);
  });

  it('survives schema-rejected messages (zod) without dropping the connection', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'transformUpdate', p: ['a', 'b', 'c'], r: 0, a: 0 }));
    conn.handleRaw(JSON.stringify({ type: 'noSuchType' }));
    conn.handleRaw(JSON.stringify({ type: 'transformUpdate', p: [1, 2, Infinity], r: 0, a: 0 }));
    expect(socket.ofType('error').every((e) => e.code === 'bad_message')).toBe(true);
    expect(socket.ofType('error')).toHaveLength(3);
    expect(socket.closed).toBeNull();
  });

  it('transformUpdate outside a session is refused with not_in_session', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'transformUpdate', p: [0, 0, 0], r: 0, a: 0 }));
    expect(socket.ofType('error')[0]?.code).toBe('not_in_session');
  });
});

describe('heartbeat / RTT EWMA', () => {
  it('measures RTT from pong echoes and smooths with EWMA', () => {
    const { connect, clock } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));

    conn.sendHeartbeat();
    const ping1 = socket.ofType('ping')[0]!;
    expect(ping1.yourPing).toBeNull();
    clock.advance(50);
    conn.handleRaw(JSON.stringify({ type: 'pong', t: ping1.t }));
    expect(conn.player?.pingMs).toBe(50);

    conn.sendHeartbeat();
    const ping2 = socket.ofType('ping')[1]!;
    expect(ping2.yourPing).toBe(50); // own ping echoed back to the client
    clock.advance(100);
    conn.handleRaw(JSON.stringify({ type: 'pong', t: ping2.t }));
    // EWMA(0.25): 50 + 0.25 × (100 − 50) = 62.5
    expect(conn.player?.pingMs).toBeCloseTo(62.5);
  });

  it('flags stale connections that stopped ponging', () => {
    const { connect, clock } = makeHarness();
    const { conn } = connect();
    expect(conn.isStale(8000)).toBe(false);
    clock.advance(9000);
    expect(conn.isStale(8000)).toBe(true);
  });
});

describe('relay clamps (TEMPORARY Phase 2)', () => {
  const prevAt = (x: number, z: number, t: number) => ({
    p: [x, 0, z] as [number, number, number],
    r: 0,
    a: 0,
    t,
    dirty: false,
  });

  it('passes plausible movement through unclamped', () => {
    // 66 ms at 6 u/s sprint = 0.4 u — well inside the allowance.
    const out = clampRelayTransform(prevAt(0, 0, 1000), { type: 'transformUpdate', p: [0.4, 0, 0], r: 1, a: 1 }, 1066);
    expect(out.p[0]).toBeCloseTo(0.4);
    expect(out.r).toBe(1);
    expect(out.a).toBe(1);
  });

  it('clamps a teleport to the max plausible displacement', () => {
    const dtSec = 0.066;
    const out = clampRelayTransform(
      prevAt(0, 0, 1000),
      { type: 'transformUpdate', p: [100, 0, 0], r: 0, a: 0 },
      1066,
    );
    const maxDist = RELAY_MAX_SPEED * RELAY_SPEED_TOLERANCE * dtSec;
    expect(out.p[0]).toBeLessThanOrEqual(maxDist + 0.01);
    expect(out.p[0]).toBeGreaterThan(0);
  });

  it('caps the elapsed-time allowance so long gaps cannot authorize teleports', () => {
    const out = clampRelayTransform(
      prevAt(0, 0, 0),
      { type: 'transformUpdate', p: [100, 0, 0], r: 0, a: 0 },
      60_000, // a minute later
    );
    expect(out.p[0]).toBeLessThanOrEqual(RELAY_MAX_SPEED * RELAY_SPEED_TOLERANCE * 0.5 + 0.01);
  });

  it('keeps positions inside the hub clearing radius', () => {
    const out = clampRelayTransform(null, { type: 'transformUpdate', p: [100, 0, 100], r: 0, a: 0 }, 0);
    expect(Math.hypot(out.p[0], out.p[2])).toBeLessThanOrEqual(HUB_BOUNDS_RADIUS + 1e-6);
  });

  it('clamps vertical position into the sane range', () => {
    const out = clampRelayTransform(null, { type: 'transformUpdate', p: [0, 500, 0], r: 0, a: 0 }, 0);
    expect(out.p[1]).toBeLessThanOrEqual(40);
  });
});

describe('transform relay end-to-end (manager level)', () => {
  it('relays clamped transforms to session peers, excluding the sender', () => {
    const { connect, clock, manager } = makeHarness();
    const a = connect();
    a.conn.handleRaw(hello());
    a.conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    const code = a.socket.ofType('welcome')[0]!.session.code;
    const b = connect();
    b.conn.handleRaw(hello());
    b.conn.handleRaw(JSON.stringify({ type: 'joinSession', code }));

    clock.advance(66);
    a.conn.handleRaw(JSON.stringify({ type: 'transformUpdate', p: [1, 0, 2], r: 0.5, a: 1 }));
    flushTransforms(manager);

    const bBatches = b.socket.ofType('transformBatch');
    expect(bBatches).toHaveLength(1);
    expect(bBatches[0]!.transforms[0]).toMatchObject({ id: a.conn.player!.id, p: [1, 0, 2], r: 0.5, a: 1 });
    // Sender got no echo of its own transform.
    expect(a.socket.ofType('transformBatch')).toHaveLength(0);
    // Dirty flag cleared — second flush without updates sends nothing.
    flushTransforms(manager);
    expect(b.socket.ofType('transformBatch')).toHaveLength(1);
  });

  it('disconnect removes the player and notifies the peer', () => {
    const { connect } = makeHarness();
    const a = connect();
    a.conn.handleRaw(hello());
    a.conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    const code = a.socket.ofType('welcome')[0]!.session.code;
    const b = connect();
    b.conn.handleRaw(hello());
    b.conn.handleRaw(JSON.stringify({ type: 'joinSession', code }));

    const bId = b.conn.player!.id;
    b.conn.handleClose();
    expect(a.socket.ofType('playerLeft')[0]).toMatchObject({ playerId: bId, reason: 'disconnected' });
  });
});
