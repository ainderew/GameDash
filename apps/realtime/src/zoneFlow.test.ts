import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { PROTOCOL_VERSION, SIM_HZ, ZONE_COUNTDOWN_SECONDS } from '@shared/net/constants';
import { SessionManager } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { silentLogger } from './log';

/**
 * Phase 6 Task 2: the expedition-gate countdown (start / cancel / fire) and the
 * return-to-hub path, driven end to end through the connection + session step loop.
 */

class FakeSocket implements SocketLike {
  sent: ServerMessage[] = [];
  closed: { code?: number } | null = null;
  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code?: number): void {
    this.closed = { code };
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

const hello = JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'T', character: 'hero' });

const setup = () => {
  const manager = new SessionManager({ log: silentLogger });
  const socket = new FakeSocket();
  const conn = new ClientConnection(socket, manager, () => Date.now(), silentLogger);
  conn.handleRaw(hello);
  conn.handleRaw(JSON.stringify({ type: 'createSession' }));
  const session = conn.session!;
  const stepN = (n: number) => {
    for (let i = 0; i < n; i += 1) session.step(1 / SIM_HZ);
  };
  const send = (type: string) => conn.handleRaw(JSON.stringify({ type }));
  return { socket, conn, session, stepN, send };
};

describe('expedition-gate countdown', () => {
  it('start → ticks → fires the zone flip at zero', () => {
    const { socket, session, stepN, send } = setup();
    send('requestZoneCountdown');
    const first = socket.ofType('zoneCountdown')[0]!;
    expect(first).toMatchObject({ active: true, secondsLeft: ZONE_COUNTDOWN_SECONDS });
    expect(session.countdownActive).toBe(true);

    stepN(ZONE_COUNTDOWN_SECONDS * SIM_HZ);
    expect(session.zone).toBe('expedition');
    expect(socket.ofType('zoneChanged').some((m) => m.zone === 'expedition')).toBe(true);
    // The banner counted all the way down (distinct seconds broadcast).
    const seconds = socket.ofType('zoneCountdown').filter((m) => m.active).map((m) => m.secondsLeft);
    expect(new Set(seconds)).toEqual(new Set([5, 4, 3, 2, 1]));
  });

  it('cancel stops the countdown and never flips the zone', () => {
    const { socket, session, stepN, send } = setup();
    send('requestZoneCountdown');
    stepN(SIM_HZ); // ~1 s in
    send('cancelZoneCountdown');
    expect(session.countdownActive).toBe(false);
    expect(socket.ofType('zoneCountdown').at(-1)).toMatchObject({ active: false });
    stepN(ZONE_COUNTDOWN_SECONDS * SIM_HZ);
    expect(session.zone).toBe('hub');
  });

  it('a second start while one is running is a no-op (single countdown)', () => {
    const { socket, send } = setup();
    send('requestZoneCountdown');
    send('requestZoneCountdown');
    // Only the initial "5" opened the banner (no duplicate open).
    expect(socket.ofType('zoneCountdown').filter((m) => m.secondsLeft === 5)).toHaveLength(1);
  });

  it('start is ignored while already in the expedition', () => {
    const { session, stepN, send } = setup();
    send('requestZoneCountdown');
    stepN(ZONE_COUNTDOWN_SECONDS * SIM_HZ);
    expect(session.zone).toBe('expedition');
    send('requestZoneCountdown');
    expect(session.countdownActive).toBe(false);
  });
});

describe('return to hub', () => {
  it('returnToHub flips an expedition party back to the hub', () => {
    const { socket, session, stepN, send } = setup();
    send('requestZoneCountdown');
    stepN(ZONE_COUNTDOWN_SECONDS * SIM_HZ);
    expect(session.zone).toBe('expedition');

    send('returnToHub');
    expect(session.zone).toBe('hub');
    expect(socket.ofType('zoneChanged').some((m) => m.zone === 'hub')).toBe(true);
  });
});
