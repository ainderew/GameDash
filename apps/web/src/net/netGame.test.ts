import { describe, expect, it } from 'vitest';
import { createGameWorld } from '@sim/world';
import { EventQueue } from '@sim/events';
import type { Entity } from '@sim/components';
import { netGame } from '@/net/netGame';

/**
 * Regression: the "can't move" freeze. The server's per-player input queue discards any
 * cmd with `seq <= lastProcessedSeq` (it never re-simulates the past). `lastProcessedSeq`
 * persists for the whole session, so if the client restarts its `seq` counter at 0 on a
 * netGame restart — a transient reconnect flip, or returning to the hub from an expedition —
 * the server drops the fresh low-seq cmds as stale, the avatar never advances server-side,
 * and every ack lands in prediction's teleport-back branch: the avatar is frozen at spawn.
 *
 * The fix: seq is monotonic across start()/stop() and only resets on a full disconnect
 * (resetEpoch), where a brand-new connection genuinely starts a new input epoch.
 */

const makeLocalPlayer = (): { world: ReturnType<typeof createGameWorld>; entity: Entity } => {
  const world = createGameWorld();
  const entity = world.add({
    transform: { position: [0, 0, 0], rotationY: 0 },
    velocity: { linear: [0, 0, 0] },
    health: { current: 100, max: 100 },
    faction: 'player',
    radius: 0.45,
    playerControlled: true,
    localPlayer: true,
  });
  return { world, entity };
};

const MOVE = { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false };

describe('netGame input-seq epoch (movement-lock regression)', () => {
  it('keeps seq monotonic across a stop()/start() restart, resetting only on resetEpoch()', () => {
    const { world, entity } = makeLocalPlayer();
    const noop = (): void => {};

    netGame.resetEpoch(); // clean baseline for this shared singleton
    netGame.start(world, new EventQueue(), entity, noop);
    netGame.clientTick(MOVE);
    netGame.clientTick(MOVE);
    netGame.clientTick(MOVE);
    const afterFirstRun = netGame.tickTimeMs; // seq × MS_PER_TICK — strictly grows with seq
    expect(afterFirstRun).toBeGreaterThan(0);

    // Transient disconnect flip (reconnecting → connected, or hub↔expedition): NOT a full
    // disconnect. The server still holds this player with a high lastProcessedSeq.
    netGame.stop();
    netGame.start(world, new EventQueue(), entity, noop);
    netGame.clientTick(MOVE);

    // seq CONTINUED past the first run — the server will accept it (seq > lastProcessedSeq),
    // so movement resumes instead of freezing.
    expect(netGame.tickTimeMs).toBeGreaterThan(afterFirstRun);

    // A genuine disconnect starts a new epoch: seq resets so a fresh connection is clean.
    netGame.resetEpoch();
    expect(netGame.tickTimeMs).toBe(0);
  });

  it('rebinds prediction when the rendered local-player entity is remounted', () => {
    const first = makeLocalPlayer();
    const second = makeLocalPlayer();
    const noop = (): void => {};

    netGame.resetEpoch();
    netGame.start(first.world, new EventQueue(), first.entity, noop);
    netGame.clientTick(MOVE);
    const seqBeforeRemount = netGame.tickTimeMs;
    expect(netGame.drives(first.entity)).toBe(true);
    expect(netGame.drives(second.entity)).toBe(false);

    // Mirrors a Suspense-driven <Player> remount: SystemRunner sees a different local entity
    // while netGame is still active and must replace the stale prediction engine.
    netGame.start(second.world, new EventQueue(), second.entity, noop);
    expect(netGame.drives(first.entity)).toBe(false);
    expect(netGame.drives(second.entity)).toBe(true);

    const before = [...second.entity.transform!.position];
    netGame.clientTick(MOVE);
    expect(second.entity.transform!.position).not.toEqual(before);
    expect(netGame.tickTimeMs).toBeGreaterThan(seqBeforeRemount); // same server input epoch

    netGame.resetEpoch();
  });
});
