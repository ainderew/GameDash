import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/constants';
import { encodeInputPacket, makeInputCmd } from '@shared/net/input';
import { SessionManager } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { silentLogger } from './log';

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

const moveCmd = (seq: number) =>
  makeInputCmd(seq, seq, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false });

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
    expect(welcome.session.members[0]!.entityId).toBeGreaterThan(0);
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
    conn.handleRaw(JSON.stringify({ type: 'noSuchType' }));
    conn.handleRaw(JSON.stringify({ type: 'hello', protocolVersion: 'x' }));
    expect(socket.ofType('error').every((e) => e.code === 'bad_message')).toBe(true);
    expect(socket.ofType('error')).toHaveLength(2);
    expect(socket.closed).toBeNull();
  });

  it('REJECTS client transforms: the v1 transformUpdate is no longer in the protocol', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    conn.handleRaw(JSON.stringify({ type: 'transformUpdate', p: [1, 0, 2], r: 0.5, a: 1 }));
    expect(socket.ofType('error')[0]?.code).toBe('bad_message');
    // And nothing moved: the avatar stays exactly where the server put it.
    const e = conn.player!.entity;
    expect(e.transform!.position[1]).toBe(0);
    expect(Math.hypot(e.transform!.position[0], e.transform!.position[2])).toBeCloseTo(3.2, 5);
  });
});

describe('binary input path', () => {
  it('routes decoded InputCmds into the player queue', () => {
    const { connect } = makeHarness();
    const { conn } = connect();
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    conn.handleBinary(encodeInputPacket([moveCmd(1), moveCmd(2), moveCmd(3)]));
    expect(conn.player!.input.depth).toBe(3);
    // Redundant re-send de-dups.
    conn.handleBinary(encodeInputPacket([moveCmd(2), moveCmd(3), moveCmd(4)]));
    expect(conn.player!.input.depth).toBe(4);
    expect(conn.player!.input.duplicatesDropped).toBe(2);
  });

  it('drops binary before a session, malformed frames, and wrong types without crashing', () => {
    const { connect } = makeHarness();
    const { socket, conn } = connect();
    conn.handleBinary(encodeInputPacket([moveCmd(1)])); // not in a session
    conn.handleRaw(hello());
    conn.handleRaw(JSON.stringify({ type: 'createSession' }));
    conn.handleBinary(new ArrayBuffer(0));
    conn.handleBinary(new Uint8Array([99, 1, 2, 3]).buffer); // unknown type byte
    conn.handleBinary(new Uint8Array([1, 3, 0]).buffer); // truncated MSG_INPUT
    expect(conn.player!.input.depth).toBe(0);
    expect(socket.closed).toBeNull();
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

describe('lifecycle', () => {
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
