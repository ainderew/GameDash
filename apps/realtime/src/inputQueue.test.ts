import { describe, expect, it } from 'vitest';
import { makeInputCmd, type InputCmd } from '@shared/net/input';
import {
  JITTER_BUFFER_INITIAL_DEPTH,
  STARVATION_COAST_MAX_TICKS,
} from '@shared/net/constants';
import { PlayerInputQueue } from './inputQueue';

const cmd = (seq: number, moveX = 1, extras: Partial<{ jump: boolean; dodge: boolean; sprint: boolean }> = {}): InputCmd =>
  makeInputCmd(seq, seq, {
    moveX,
    moveZ: 0,
    jump: extras.jump ?? false,
    dodge: extras.dodge ?? false,
    sprint: extras.sprint ?? false,
  });

describe('PlayerInputQueue', () => {
  it('is idle (zero intent, no coasting counted) before any cmd ever arrives', () => {
    const q = new PlayerInputQueue();
    const r = q.consume();
    expect(r.seq).toBeNull();
    expect(r.intent.moveX).toBe(0);
    expect(q.starvations).toBe(0);
  });

  it('waits for the jitter target depth, then consumes in seq order 1/tick', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s < JITTER_BUFFER_INITIAL_DEPTH; s += 1) {
      q.offer(cmd(s));
      expect(q.consume().seq).toBeNull(); // below target: still filling
    }
    q.offer(cmd(JITTER_BUFFER_INITIAL_DEPTH));
    expect(q.consume().seq).toBe(1);
    expect(q.consume().seq).toBe(2);
    expect(q.consume().seq).toBe(3);
    expect(q.lastProcessedSeq).toBe(3);
  });

  it('de-dups redundant cmds and discards anything at or below lastProcessedSeq', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) q.offer(cmd(s));
    q.offer(cmd(1)); // redundant re-send
    expect(q.duplicatesDropped).toBe(1);
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) q.consume();
    q.offer(cmd(2)); // late duplicate of the past
    q.offer(cmd(1));
    expect(q.duplicatesDropped).toBe(3);
    expect(q.depth).toBe(0);
  });

  it('NEVER yields an already-simulated seq — a late packet cannot rewrite the past', () => {
    const q = new PlayerInputQueue();
    q.offer(cmd(1));
    q.offer(cmd(2));
    q.offer(cmd(4)); // 3 lost
    q.offer(cmd(5));
    expect(q.consume().seq).toBe(1);
    expect(q.consume().seq).toBe(2);
    expect(q.consume().seq).toBe(4); // gap skipped forward, not waited on
    expect(q.gapsSkipped).toBe(1);
    q.offer(cmd(3)); // the missing cmd finally arrives — TOO LATE
    const r = q.consume();
    expect(r.seq).not.toBe(3);
    expect(q.lastProcessedSeq).toBeGreaterThanOrEqual(4);
  });

  it('starvation coasts on the last MOVEMENT with one-shot actions stripped, then stops', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) {
      q.offer(cmd(s, 1, { jump: true, dodge: true, sprint: true }));
    }
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) expect(q.consume().seq).toBe(s);
    // Starved now.
    for (let i = 0; i < STARVATION_COAST_MAX_TICKS; i += 1) {
      const r = q.consume();
      expect(r.coasting).toBe(true);
      expect(r.seq).toBeNull();
      expect(r.intent.moveX).toBeCloseTo(1); // movement coasts
      expect(r.intent.sprint).toBe(true); // held modifier coasts
      expect(r.intent.jump).toBe(false); // one-shots stripped
      expect(r.intent.dodge).toBe(false);
    }
    // Past the cap: full stop, still never a seq.
    const r = q.consume();
    expect(r.coasting).toBe(true);
    expect(r.intent.moveX).toBe(0);
    expect(q.lastProcessedSeq).toBe(JITTER_BUFFER_INITIAL_DEPTH);
  });

  it('grows the target depth on starvation and refills before resuming', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) q.offer(cmd(s));
    for (let s = 1; s <= JITTER_BUFFER_INITIAL_DEPTH; s += 1) q.consume();
    expect(q.targetDepth).toBe(JITTER_BUFFER_INITIAL_DEPTH);
    q.consume(); // starve
    expect(q.starvations).toBe(1);
    expect(q.targetDepth).toBe(JITTER_BUFFER_INITIAL_DEPTH + 1);
    // Refill gate: with depth < target it keeps coasting even though cmds exist.
    const next = JITTER_BUFFER_INITIAL_DEPTH + 1;
    q.offer(cmd(next));
    expect(q.consume().seq).toBeNull();
    for (let k = 1; k <= JITTER_BUFFER_INITIAL_DEPTH; k += 1) q.offer(cmd(next + k));
    // Two moving coast ticks happened → two stale cmds are absorbed (substituted), and
    // consumption resumes on the next one — seq/tick alignment preserved.
    const r = q.consume();
    expect(r.seq).toBe(next + 2);
    expect(q.substituted).toBe(2);
  });

  it('COAST SUBSTITUTION: absorbed gap cmds are never re-simulated, verbs never swallowed', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s <= 4; s += 1) q.offer(cmd(s));
    for (let s = 1; s <= 4; s += 1) expect(q.consume().seq).toBe(s);
    // 3 moving coast ticks.
    for (let i = 0; i < 3; i += 1) expect(q.consume().coasting).toBe(true);
    // The late burst arrives: 5,6 are pure movement, 7 carries a dodge, 8..10 movement.
    q.offer(cmd(5));
    q.offer(cmd(6));
    q.offer(cmd(7, 1, { dodge: true }));
    for (let s = 8; s <= 10; s += 1) q.offer(cmd(s));
    const r = q.consume();
    // 5 and 6 absorbed by the coast; substitution STOPS at the dodge — 7 is simulated.
    expect(r.seq).toBe(7);
    expect(r.intent.dodge).toBe(true);
    expect(q.substituted).toBe(2);
    expect(q.lastProcessedSeq).toBe(7);
  });

  it('grows the target depth from MEASURED arrival jitter', () => {
    const q = new PlayerInputQueue();
    // 40 packets alternating 3 ms / 63 ms gaps (nominal 33.3) — heavy jitter.
    let t = 0;
    for (let s = 1; s <= 40; s += 1) {
      t += s % 2 === 0 ? 3 : 63;
      q.offer(cmd(s), t);
      q.consume();
    }
    expect(q.targetDepth).toBeGreaterThan(JITTER_BUFFER_INITIAL_DEPTH);
  });

  it('bounds the backlog by dropping the OLDEST cmds on overflow', () => {
    const q = new PlayerInputQueue();
    for (let s = 1; s <= 30; s += 1) q.offer(cmd(s));
    expect(q.depth).toBeLessThanOrEqual(q.targetDepth + 8);
    expect(q.overflowDropped).toBeGreaterThan(0);
    // What remains is the NEWEST window.
    const depth = q.depth;
    expect(q.consume().seq).toBe(30 - depth + 1);
  });
});
