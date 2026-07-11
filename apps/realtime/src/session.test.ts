import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@shared/net/messages';
import { MS_PER_TICK, POSITION_HISTORY_TICKS, SESSION_GC_GRACE_MS } from '@shared/net/constants';
import { decodeSnapshot } from '@shared/net/snapshot';
import { makeInputCmd } from '@shared/net/input';
import { createMonster } from '@sim/systems/spawnSystem';
import { SessionManager, type PeerLink, type PlayerProfile } from './session';
import { silentLogger } from './log';

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

const makeManager = () => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const manager = new SessionManager({ now: clock.now, log: silentLogger });
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

describe('Session authoritative sim (Phase 3)', () => {
  const dt = MS_PER_TICK / 1000;

  it('spawns an avatar entity on join and despawns it on leave', () => {
    const { manager } = makeManager();
    const { session, player } = manager.createSession(profile('Ana'), new FakeLink());
    expect(player.entity.id).toBeGreaterThan(0);
    expect(session.world.with('playerControlled').entities).toHaveLength(1);
    const join = manager.joinSession(session.code, profile('Ben'), new FakeLink());
    expect(session.world.with('playerControlled').entities).toHaveLength(2);
    if (join.ok) manager.removePlayer(session, join.player.id, 'left');
    expect(session.world.with('playerControlled').entities).toHaveLength(1);
  });

  it('keeps each session world FULLY isolated (no cross-session entity leaks)', () => {
    const { manager } = makeManager();
    const a = manager.createSession(profile('Ana'), new FakeLink());
    const b = manager.createSession(profile('Ben'), new FakeLink());
    expect(a.session.world).not.toBe(b.session.world);
    expect(a.session.world.with('playerControlled').entities).toHaveLength(1);
    expect(b.session.world.with('playerControlled').entities).toHaveLength(1);
    // Step one session 50 ticks with movement — the other world must not move at all.
    for (let s = 1; s <= 50; s += 1) {
      a.player.input.offer(makeInputCmd(s, s, { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: true }));
    }
    const bBefore = [...b.player.entity.transform!.position];
    for (let t = 0; t < 50; t += 1) a.session.step(dt);
    expect(a.player.entity.transform!.position[0]).not.toBeCloseTo(0, 1);
    expect(b.player.entity.transform!.position).toEqual(bBefore);
    expect(b.session.tick).toBe(0);
  });

  it('advances lastProcessedSeq only when real cmds are consumed and records 8-tick history', () => {
    const { manager } = makeManager();
    const { session, player } = manager.createSession(profile('Ana'), new FakeLink());
    for (let s = 1; s <= 20; s += 1) {
      player.input.offer(makeInputCmd(s, s, { moveX: 0, moveZ: 1, jump: false, dodge: false, sprint: false }));
    }
    for (let t = 0; t < 20; t += 1) session.step(dt);
    expect(player.input.lastProcessedSeq).toBeGreaterThan(0);
    expect(player.ackState.seq).toBe(player.input.lastProcessedSeq);
    expect(player.posHistory).toHaveLength(POSITION_HISTORY_TICKS);
    // History is the last 8 CONSECUTIVE ticks.
    const ticks = player.posHistory.map((h) => h.tick);
    expect(ticks[ticks.length - 1]).toBe(session.tick);
    expect(ticks[0]).toBe(session.tick - POSITION_HISTORY_TICKS + 1);
  });

  it('broadcasts a keyframe snapshot first, then deltas, keyframes on membership change', () => {
    const { manager } = makeManager();
    const link = new FakeLink();
    const { session, player } = manager.createSession(profile('Ana'), link);
    session.step(dt);
    session.broadcastSnapshots();
    const first = decodeSnapshot(link.binary[0]!)!;
    expect(first.header.keyframe).toBe(true);
    expect(first.entities.map((e) => e.id)).toContain(player.entity.id);

    session.step(dt);
    session.broadcastSnapshots();
    const second = decodeSnapshot(link.binary[1]!)!;
    expect(second.header.keyframe).toBe(false);
    expect(second.header.baselineTick).toBe(first.header.serverTick);

    manager.joinSession(session.code, profile('Ben'), new FakeLink());
    session.broadcastSnapshots();
    const third = decodeSnapshot(link.binary[2]!)!;
    expect(third.header.keyframe).toBe(true);
    expect(third.entities).toHaveLength(2);
  });

  it('impulse messages carry the replay seq only to the owner', () => {
    const { manager } = makeManager();
    const aLink = new FakeLink();
    const bLink = new FakeLink();
    const { session, player: ana } = manager.createSession(profile('Ana'), aLink);
    manager.joinSession(session.code, profile('Ben'), bLink);
    session.queueImpulse(ana.id, [5, 0, 0]);
    const aImp = aLink.ofType('impulse')[0]!;
    const bImp = bLink.ofType('impulse')[0]!;
    expect(aImp.seq).toBe(ana.input.lastProcessedSeq + 1);
    expect(bImp.seq).toBeUndefined();
    expect(aImp.entityId).toBe(ana.entity.id);
    // Applied at the next tick: the avatar gets shoved.
    const before = ana.entity.transform!.position[0];
    session.step(dt);
    expect(ana.entity.transform!.position[0]).toBeGreaterThan(before);
  });
});

describe('Session authoritative combat (Phase 4)', () => {
  const dt = MS_PER_TICK / 1000;

  it('entering the expedition seeds a wave and announces zone + spawns + wave (with serverTick)', () => {
    const { manager } = makeManager();
    const link = new FakeLink();
    const { session } = manager.createSession(profile('Ana'), link);
    session.enterZone('expedition');
    expect(session.zone).toBe('expedition');
    expect(link.ofType('zoneChanged')[0]).toMatchObject({ zone: 'expedition' });

    session.step(dt); // spawnSystem seeds wave 1
    expect(session.world.with('monster').entities.length).toBeGreaterThan(0);
    const spawned = link.ofType('monsterSpawned');
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0]!.serverTick).toBe(session.tick);
    expect(spawned[0]!.archetype).toBe('chaser');
    const waves = link.ofType('waveStarted');
    expect(waves).toHaveLength(1);
    expect(waves[0]!.wave).toBe(1);
  });

  it('a lag-compensated melee CONFIRMS DamageDealt (stamped with serverTick), kills → despawn + SHARED loot tally', () => {
    const { manager } = makeManager();
    const aLink = new FakeLink();
    const bLink = new FakeLink();
    const { session, player: ana } = manager.createSession(profile('Ana'), aLink);
    manager.joinSession(session.code, profile('Ben'), bLink);
    session.enterZone('expedition');

    // Drop a lone stationary monster right in front of Ana (in melee reach + pickup range),
    // and remove the seeded wave so only this monster exists.
    session.step(dt);
    for (const m of [...session.world.with('monster')]) session.world.remove(m);
    const p = ana.entity.transform!.position;
    ana.entity.transform!.rotationY = 0; // face +Z
    const monster = session.world.add(createMonster('chaser', [p[0], 0, p[2] + 1.2]));
    monster.health!.current = 20; // one committed swing (34 dmg) finishes it deterministically
    const aimYaw = 0; // toward +Z, at the monster

    // Ana mashes melee (a real client input stream) with a fresh view time each tick.
    for (let s = 1; s <= 60; s += 1) {
      const cmd = makeInputCmd(s, s, {
        moveX: 0,
        moveZ: 0,
        jump: false,
        dodge: false,
        sprint: false,
        melee: true,
        aimYaw,
        viewServerTimeMs: s * MS_PER_TICK,
      });
      ana.input.offer(cmd);
    }
    const startHp = monster.health!.current;
    for (let t = 0; t < 60; t += 1) session.step(dt);

    // DamageDealt confirmed on the wire, stamped with the tick it happened (ordering vs snapshots).
    const dmg = aLink.ofType('damageDealt');
    expect(dmg.length).toBeGreaterThan(0);
    expect(dmg[0]!.targetKind).toBe('monster');
    expect(dmg[0]!.targetId).toBe(monster.id);
    expect(dmg[0]!.amount).toBeGreaterThan(0);
    expect(dmg[0]!.serverTick).toBeGreaterThan(0);
    // Both party members receive the same DamageDealt (it's a broadcast).
    expect(bLink.ofType('damageDealt').length).toBe(dmg.length);

    // The monster died → despawn event + it's gone from the world.
    expect(monster.health!.current).toBeLessThan(startHp);
    expect(monster.health!.current).toBe(0);
    const despawn = aLink.ofType('monsterDespawned');
    expect(despawn.length).toBe(1);
    expect(despawn[0]!).toMatchObject({ id: monster.id, reason: 'killed' });
  });

  it('SHARED-POOL loot: a collected pickup tallies to EVERY member from server events', () => {
    const { manager } = makeManager();
    const aLink = new FakeLink();
    const bLink = new FakeLink();
    const { session, player: ana } = manager.createSession(profile('Ana'), aLink);
    manager.joinSession(session.code, profile('Ben'), bLink);
    session.enterZone('expedition');
    for (const m of [...session.world.with('monster')]) session.world.remove(m);

    // A material lying on Ana's feet — the sim auto-collects it next tick.
    const before = session.materials;
    const p = ana.entity.transform!.position;
    session.world.add({ transform: { position: [p[0], 0.5, p[2]], rotationY: 0 }, pickup: { tableId: 'common' } });
    for (let t = 0; t < 3; t += 1) session.step(dt);

    const tallyA = aLink.ofType('materialTally');
    const tallyB = bLink.ofType('materialTally');
    expect(tallyA).toHaveLength(1);
    expect(tallyB).toHaveLength(1); // Ben's pool rises too, though Ana walked over it
    expect(tallyA[0]!.total).toBe(before + 1);
    expect(tallyA[0]!.total).toBe(session.materials);
  });

  it('all players downed → HuntFailed then auto-return to the hub', () => {
    const { manager } = makeManager();
    const link = new FakeLink();
    const { session, player } = manager.createSession(profile('Ana'), link);
    session.enterZone('expedition');
    // Force the down state and run a step so the all-downed check fires.
    player.entity.health!.current = 0;
    player.entity.downed = true;
    session.step(dt);
    expect(link.ofType('huntFailed')).toHaveLength(1);
    expect(session.zone).toBe('hub');
    // Returning to the hub full-heals + clears downed (the party respawns at the campfire).
    expect(player.entity.downed).toBe(false);
    expect(player.entity.health!.current).toBe(player.entity.health!.max);
  });
});
