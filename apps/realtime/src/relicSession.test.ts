import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { MS_PER_TICK } from '@shared/net/constants';
import { decodeSnapshot } from '@shared/net/snapshot';
import { makeInputCmd, type CmdIntent } from '@shared/net/input';
import { relicInvariantViolation } from '@sim/systems/relicSystem';
import { SessionManager, type PeerLink, type PlayerProfile } from './session';
import { silentLogger } from './log';

/**
 * Phase 5 server-context relic suite: the ported relicSystem scenarios (caught, receiver
 * downed/escaped fail + rotation refund) now exercised through the REAL server path (Session
 * → stepSim authority 'server' → wire events), plus the netcode-only cases: pass rejection,
 * carrier-disconnect drop, and the late-join welcome flight. The single-source-of-truth
 * invariant is asserted alongside.
 */

class FakeLink implements PeerLink {
  messages: ServerMessage[] = [];
  binary: ArrayBuffer[] = [];
  send(msg: ServerMessage): void {
    this.messages.push(msg);
  }
  sendBinary(data: ArrayBuffer): void {
    this.binary.push(data);
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.messages.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

const profile = (name: string): PlayerProfile => ({ name, character: 'hero' });
const dt = MS_PER_TICK / 1000;

const makeManager = () => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return new SessionManager({ now: clock.now, log: silentLogger });
};

const neutral = (s: number): ReturnType<typeof makeInputCmd> =>
  makeInputCmd(s, s, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false });

const passCmd = (s: number, intent: Partial<CmdIntent>): ReturnType<typeof makeInputCmd> =>
  makeInputCmd(s, s, { moveX: 0, moveZ: 0, jump: false, dodge: false, sprint: false, passHold: true, ...intent });

/** Two players in the expedition, Ana carrying the relic, monsters stripped. */
const setup = () => {
  const manager = makeManager();
  const aLink = new FakeLink();
  const bLink = new FakeLink();
  const { session, player: ana } = manager.createSession(profile('Ana'), aLink);
  const join = manager.joinSession(session.code, profile('Ben'), bLink);
  if (!join.ok) throw new Error('join failed');
  const ben = join.player;
  session.enterZone('expedition');
  // Ana stands on the grounded relic and claims it on the next step; strip the seeded wave.
  ana.entity.transform!.position = [1.5, 0, -4];
  session.step(dt);
  for (const m of [...session.world.with('monster')]) session.world.remove(m);
  aLink.messages.length = 0;
  bLink.messages.length = 0;
  return { manager, session, ana, ben, aLink, bLink };
};

describe('Session relic relay (Phase 5)', () => {
  it('entering the expedition spawns exactly one grounded relic that replicates via snapshot', () => {
    const manager = makeManager();
    const link = new FakeLink();
    const { session } = manager.createSession(profile('Ana'), link);
    session.enterZone('expedition');
    expect(session.world.with('relic').entities).toHaveLength(1);
    expect(session.world.with('relic').first!.relic!.phase).toBe('grounded');
    expect(relicInvariantViolation(session.world)).toBeNull();
    // Existence rides the snapshot (kind=relic), not a separate spawn broadcast.
    session.step(dt);
    session.broadcastSnapshots();
    const snap = decodeSnapshot(link.binary.at(-1)!)!;
    const relicId = session.world.with('relic').first!.id;
    expect(snap.entities.map((e) => e.id)).toContain(relicId);
  });

  it('setup hands the relic to Ana (a legitimate walk-in catch)', () => {
    const { session, ana } = setup();
    const relic = session.world.with('relic').first!;
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(ana.entity);
    expect(relicInvariantViolation(session.world)).toBeNull();
  });

  /** Drive Ana's pass to Ben at [x,z]; returns the launch event once observed (or null). */
  const throwAndSettle = (
    ctx: ReturnType<typeof setup>,
    benPos: [number, number, number],
    opts: { downBenAfterLaunch?: boolean; teleportBenAfterLaunch?: [number, number, number] } = {},
  ) => {
    const { session, ana, ben, aLink } = ctx;
    ben.entity.transform!.position = benPos;
    // Aim yaw toward Ben on XZ (forward = [sin, cos]).
    const ap = ana.entity.transform!.position;
    const aimYaw = Math.atan2(benPos[0] - ap[0], benPos[2] - ap[2]);
    let launched = false;
    let invariantOk = true;
    for (let t = 0; t < 60; t += 1) {
      const s = t + 1;
      // Throw on the 5th cmd; neutral otherwise (one cmd per tick, like a real client).
      if (s === 5) {
        ana.input.offer(
          passCmd(s, { passTargetId: ben.entity.id!, aimYaw, viewServerTimeMs: session.simNowMs }),
        );
      } else {
        ana.input.offer(neutral(s));
      }
      session.step(dt);
      if (relicInvariantViolation(session.world) !== null) invariantOk = false;
      if (!launched && aLink.ofType('relicLaunched').length > 0) {
        launched = true;
        if (opts.downBenAfterLaunch) {
          ben.entity.health!.current = 0;
          ben.entity.downed = true;
        }
        if (opts.teleportBenAfterLaunch) ben.entity.transform!.position = opts.teleportBenAfterLaunch;
      }
    }
    return { launched, invariantOk };
  };

  it('a valid pass launches (flight params + serverTick), and Ben catches it', () => {
    const ctx = setup();
    const { launched, invariantOk } = throwAndSettle(ctx, [5.5, 0, -4]);
    expect(launched).toBe(true);
    expect(invariantOk).toBe(true);

    const launch = ctx.aLink.ofType('relicLaunched')[0]!;
    expect(launch.flight.mode).toBe('pass');
    expect(launch.flight.targetId).toBe(ctx.ben.entity.id);
    expect(launch.flight.throwerId).toBe(ctx.ana.entity.id);
    expect(launch.flight.flightMs).toBeGreaterThan(0);
    expect(launch.serverTick).toBeGreaterThan(0);
    // Both members receive the launch (reliable broadcast).
    expect(ctx.bLink.ofType('relicLaunched')).toHaveLength(1);

    // Ben caught it (relicCaught fires with his entity id) → he is the carrier.
    const caught = ctx.aLink.ofType('relicCaught');
    expect(caught.length).toBeGreaterThanOrEqual(1);
    expect(caught.at(-1)!.carrierId).toBe(ctx.ben.entity.id);
    const relic = ctx.session.world.with('relic').first!;
    expect(relic.relic!.phase).toBe('carried');
    expect(relic.relic!.carrier).toBe(ctx.ben.entity);
  });

  it('rejects a pass from a NON-carrier (not_carrier), no launch', () => {
    const { session, ana, ben, bLink } = setup();
    const aimYaw = 0;
    for (let t = 0; t < 12; t += 1) {
      const s = t + 1;
      if (s === 5) {
        ben.input.offer(passCmd(s, { passTargetId: ana.entity.id!, aimYaw, viewServerTimeMs: session.simNowMs }));
      } else {
        ben.input.offer(neutral(s));
      }
      session.step(dt);
    }
    const rejects = bLink.ofType('passRejected');
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]!.reason).toBe('not_carrier');
    expect(bLink.ofType('relicLaunched')).toHaveLength(0);
  });

  it('rejects an out-of-range pass (out_of_range)', () => {
    const ctx = setup();
    throwAndSettle(ctx, [1.5 + 20, 0, -4]); // 20 m ≫ RELIC_PASS_RANGE (15)
    const rejects = ctx.aLink.ofType('passRejected');
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]!.reason).toBe('out_of_range');
    expect(ctx.aLink.ofType('relicLaunched')).toHaveLength(0);
  });

  it('rejects a pass to a receiver inside the rotation cooldown (rotation)', () => {
    const ctx = setup();
    ctx.ben.entity.relicRecatchUntil = ctx.session.simNowMs + 100_000; // ineligible
    throwAndSettle(ctx, [5.5, 0, -4]);
    const rejects = ctx.aLink.ofType('passRejected');
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]!.reason).toBe('rotation');
    expect(ctx.aLink.ofType('relicLaunched')).toHaveLength(0);
  });

  it('receiver downed mid-flight → RelicPassFailed(receiver_downed) + thrower rotation refund', () => {
    const ctx = setup();
    const { launched, invariantOk } = throwAndSettle(ctx, [5.5, 0, -4], { downBenAfterLaunch: true });
    expect(launched).toBe(true);
    expect(invariantOk).toBe(true);
    const failed = ctx.aLink.ofType('relicPassFailed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.reason).toBe('receiver_downed');
    // Refund: the thrower's rotation cooldown is cleared so they aren't stranded.
    expect(ctx.ana.entity.relicRecatchUntil).toBe(0);
    // The relic bounced and settled grounded (walk-in catchable), never limbo.
    expect(ctx.session.world.with('relic').first!.relic!.phase).toBe('grounded');
  });

  it('receiver escapes the correction budget mid-flight → RelicPassFailed(receiver_escaped)', () => {
    const ctx = setup();
    const { launched } = throwAndSettle(ctx, [5.5, 0, -4], { teleportBenAfterLaunch: [1.5, 0, 60] });
    expect(launched).toBe(true);
    const failed = ctx.aLink.ofType('relicPassFailed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.reason).toBe('receiver_escaped');
    expect(ctx.ana.entity.relicRecatchUntil).toBe(0);
  });

  it('carrier disconnect lobs the relic out with RelicDropped(disconnect)', () => {
    const { manager, session, ana, bLink } = setup();
    // Ana carries; she disconnects → the relic must lob out at her last position.
    manager.removePlayer(session, ana.id, 'disconnected');
    session.step(dt);
    const dropped = bLink.ofType('relicDropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe('disconnect');
    // A lob launch accompanies it, and the invariant still holds (exactly one relic, in flight).
    expect(bLink.ofType('relicLaunched').length).toBeGreaterThanOrEqual(1);
    expect(relicInvariantViolation(session.world)).toBeNull();
  });

  it('relicWelcome carries the active flight for a mid-flight late joiner', () => {
    const ctx = setup();
    // Throw, then snapshot the welcome exactly while the relic is in flight.
    const { session, ana, ben, aLink } = ctx;
    ben.entity.transform!.position = [5.5, 0, -4];
    const aimYaw = Math.PI / 2;
    let welcome: ReturnType<typeof session.relicWelcome> = undefined;
    for (let t = 0; t < 60; t += 1) {
      const s = t + 1;
      ana.input.offer(
        s === 5 ? passCmd(s, { passTargetId: ben.entity.id!, aimYaw, viewServerTimeMs: session.simNowMs }) : neutral(s),
      );
      session.step(dt);
      const relic = session.world.with('relic').first!;
      if (relic.relic!.phase === 'inFlight' && aLink.ofType('relicLaunched').length > 0) {
        welcome = session.relicWelcome();
        break;
      }
    }
    expect(welcome).toBeDefined();
    expect(welcome!.phase).toBe('inFlight');
    expect(welcome!.flight).toBeDefined();
    expect(welcome!.flight!.mode).toBe('pass');
  });

  it('returning to the hub removes the relic entirely (no leak across zones)', () => {
    const { session } = setup();
    session.enterZone('hub');
    expect(session.world.with('relic').entities).toHaveLength(0);
    expect(session.relicWelcome()).toBeUndefined();
  });
});
