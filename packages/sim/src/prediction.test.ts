import { describe, expect, it } from 'vitest';
import type { Vector3Tuple } from '@shared/types';
import { PLAYER_SPEED } from '@shared/balance';
import { createGameWorld } from './world';
import { EventQueue } from './events';
import type { Entity } from './components';
import { stepSim, type PlayerIntent } from './step';
import { PredictionEngine, applyImpulse, type AuthoritativeState } from './prediction';

/**
 * Prediction/reconciliation unit tests (Phase 3, Task 4). A "server" world and a
 * "client" world run the SAME stepSim over the same intents; the client's engine
 * reconciles against delayed authoritative echoes — divergence must be exactly zero,
 * corrections must converge without overshoot, and impulses must replay smoothly.
 */

const DT = 1 / 30;
const MS = 1000 / 30;

const makeSide = (spawn: Vector3Tuple = [0, 0, 0]) => {
  const world = createGameWorld();
  const events = new EventQueue();
  const entity: Entity = world.add({
    transform: { position: [...spawn] as Vector3Tuple, rotationY: Math.PI },
    velocity: { linear: [0, 0, 0] },
    health: { current: 100, max: 100 },
    faction: 'player',
    radius: 0.45,
    playerControlled: true,
  });
  return { world, events, entity };
};

const authOf = (e: Entity): AuthoritativeState => ({
  pos: [...e.transform!.position] as Vector3Tuple,
  vel: [...e.velocity!.linear] as Vector3Tuple,
  rotY: e.transform!.rotationY,
});

/** Scripted intents shared by both sides — wandering with dodges/jumps/sprint. */
const intentAt = (tick: number): PlayerIntent => {
  const angle = Math.floor(tick / 40) * 1.7;
  return {
    moveX: Math.sin(angle),
    moveZ: Math.cos(angle),
    jump: tick % 50 === 0,
    dodge: tick % 71 === 0,
    sprint: tick % 90 < 45,
  };
};

describe('PredictionEngine', () => {
  it('fires presentation hooks for fresh prediction but never during reconciliation replay', () => {
    const client = makeSide();
    let swings = 0;
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT, {
      mode: 'expedition',
      hooks: { onSwing: () => (swings += 1) },
    });
    const attack: PlayerIntent = {
      moveX: 0,
      moveZ: 0,
      jump: false,
      dodge: false,
      sprint: false,
      melee: true,
    };

    // Click one is now a complete attack and emits exactly one fresh presentation hook.
    engine.predict(1, attack, MS);
    expect(swings).toBe(1);
    const idle: PlayerIntent = { ...attack, melee: false };
    for (let seq = 2; seq <= 9; seq += 1) engine.predict(seq, idle, seq * MS);

    // Unknown ack forces a rewind + replay of the buffered inputs. The whoosh must not play twice.
    engine.onAuthoritative({ pos: [0, 0, 0], vel: [0, 0, 0], rotY: Math.PI }, 0);
    expect(swings).toBe(1);
  });

  it('scripted inputs + delayed authoritative echoes converge to ZERO error', () => {
    const server = makeSide();
    const client = makeSide();
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT);

    const serverStates = new Map<number, AuthoritativeState>();
    const ACK_DELAY = 5; // acks arrive 5 ticks late, every 2 ticks (≈20 Hz vs 30 Hz)
    let corrections = 0;
    let maxError = 0;

    for (let seq = 1; seq <= 300; seq += 1) {
      const intent = intentAt(seq);
      // Client predicts immediately…
      engine.predict(seq, intent, seq * MS);
      // …server simulates the same cmd on its own timeline.
      stepSim(server.world, server.events, new Map([[server.entity, intent]]), DT, seq * MS, 'hub');
      serverStates.set(seq, authOf(server.entity));

      const ackSeq = seq - ACK_DELAY;
      if (ackSeq >= 1 && seq % 2 === 0) {
        const result = engine.onAuthoritative(serverStates.get(ackSeq)!, ackSeq);
        if (result) {
          maxError = Math.max(maxError, result.errorM);
          if (result.kind !== 'clean') corrections += 1;
        }
      }
    }
    expect(corrections).toBe(0);
    expect(maxError).toBe(0); // same machine, same code → bit-identical
    // Present-time states are identical too.
    expect(client.entity.transform!.position).toEqual(server.entity.transform!.position);
    expect(client.entity.velocity!.linear).toEqual(server.entity.velocity!.linear);
  });

  it('a forced server nudge reconciles fully in ONE correction — no overshoot, no oscillation', () => {
    const server = makeSide();
    const client = makeSide();
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT);
    const serverStates = new Map<number, AuthoritativeState>();
    const intent: PlayerIntent = { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false };

    const NUDGE_AT = 40;
    const results: { kind: string; errorM: number }[] = [];
    for (let seq = 1; seq <= 120; seq += 1) {
      engine.predict(seq, intent, seq * MS);
      if (seq === NUDGE_AT) server.entity.transform!.position[2] += 0.5; // the nudge
      stepSim(server.world, server.events, new Map([[server.entity, intent]]), DT, seq * MS, 'hub');
      serverStates.set(seq, authOf(server.entity));
      const ackSeq = seq - 4;
      if (ackSeq >= 1) {
        const r = engine.onAuthoritative(serverStates.get(ackSeq)!, ackSeq);
        if (r) results.push({ kind: r.kind, errorM: r.errorM });
      }
    }
    const nonClean = results.filter((r) => r.kind !== 'clean');
    expect(nonClean).toHaveLength(1); // exactly one correction, then silence
    expect(nonClean[0]!.errorM).toBeCloseTo(0.5, 3);
    // After the correction the client tracks the nudged path exactly.
    expect(client.entity.transform!.position[2]).toBeCloseTo(
      server.entity.transform!.position[2],
      9,
    );
  });

  it('IMPULSE-DURING-MOVEMENT: knockback at tick N while strafing → one smooth arc, zero corrections', () => {
    const server = makeSide();
    const client = makeSide();
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT);
    const serverStates = new Map<number, AuthoritativeState>();
    const strafe: PlayerIntent = { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: false };

    const IMPULSE_SEQ = 60;
    const IMPULSE: Vector3Tuple = [0, 0, 9];
    // The impulse event reaches the client AFTER the server applied it but BEFORE the
    // snapshot ack that includes its effect — the wire is ordered and the server sends
    // the impulse the same tick, snapshots ≥ one snapshot interval later.
    const LAG = 3;
    const ACK_DELAY = 6;

    let corrections = 0;
    let impulseFoldM = 0;
    const clientTrack: number[] = []; // client z per tick — smoothness probe

    for (let seq = 1; seq <= 200; seq += 1) {
      engine.predict(seq, strafe, seq * MS);
      if (seq === IMPULSE_SEQ) applyImpulse(server.entity, IMPULSE); // server-side shove
      stepSim(server.world, server.events, new Map([[server.entity, strafe]]), DT, seq * MS, 'hub');
      serverStates.set(seq, authOf(server.entity));

      if (seq === IMPULSE_SEQ + LAG) {
        const delta = engine.scheduleImpulse(IMPULSE_SEQ, IMPULSE); // enters the replay stream
        impulseFoldM = Math.hypot(delta[0], delta[1], delta[2]);
        expect(impulseFoldM).toBeGreaterThan(0); // it DID rewind-replay the shove in…
        expect(impulseFoldM).toBeLessThanOrEqual(Math.hypot(...IMPULSE) * (LAG + 1) * DT + 1e-9); // …and kept it within the inclusive impulse replay window
      }

      const ackSeq = seq - ACK_DELAY;
      if (ackSeq >= 1) {
        const r = engine.onAuthoritative(serverStates.get(ackSeq)!, ackSeq);
        if (r && r.kind !== 'clean') corrections += 1;
      }
      clientTrack.push(client.entity.transform!.position[2]);
    }

    expect(corrections).toBe(0); // prediction and authority agree about the shove
    expect(client.entity.transform!.position[2]).toBeCloseTo(
      server.entity.transform!.position[2],
      9,
    );
    // One smooth decaying arc: once the shove is in, z deltas never spike or reverse.
    const post = clientTrack.slice(IMPULSE_SEQ + LAG);
    for (let i = 1; i < post.length; i += 1) {
      const d = post[i]! - post[i - 1]!;
      expect(d).toBeGreaterThanOrEqual(-0.005); // no meaningful backward yank; tolerate sub-centimeter replay jitter
      expect(d).toBeLessThanOrEqual(9 * DT + 1e-9); // never faster than the impulse itself
    }
  });

  it('an unknown ack (spawn/resume) is an explicit teleport that hard-syncs and replays', () => {
    const client = makeSide();
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT);
    for (let seq = 1; seq <= 3; seq += 1) {
      engine.predict(
        seq,
        { moveX: 0, moveZ: 1, jump: false, dodge: false, sprint: false },
        seq * MS,
      );
    }
    const r = engine.onAuthoritative({ pos: [10, 0, 10], vel: [0, 0, 0], rotY: 0 }, 0)!;
    expect(r.kind).toBe('teleport');
    // Present = spawn + replay of the 3 unacked cmds.
    expect(client.entity.transform!.position[0]).toBeCloseTo(10, 5);
    expect(client.entity.transform!.position[2]).toBeGreaterThan(10);
  });

  it('speed sanity: predicted movement never exceeds the sim maximum', () => {
    // Spawn clear of the hub obstacle footprints — a push-out is not "movement".
    const client = makeSide([5, 0, 5]);
    const engine = new PredictionEngine(client.world, client.events, client.entity, DT);
    let prev = client.entity.transform!.position[0];
    for (let seq = 1; seq <= 60; seq += 1) {
      engine.predict(
        seq,
        { moveX: 1, moveZ: 0, jump: false, dodge: false, sprint: true },
        seq * MS,
      );
      const x = client.entity.transform!.position[0];
      expect(x - prev).toBeLessThanOrEqual(PLAYER_SPEED * DT + 1e-9);
      prev = x;
    }
  });
});
