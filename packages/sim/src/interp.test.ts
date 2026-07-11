import { describe, expect, it } from 'vitest';
import { InterpBuffer, shortestArcLerp } from './interp';

const snap = (t: number, x: number, rotY = 0, flags?: number) => ({
  t,
  pos: [x, 0, 0] as [number, number, number],
  rotY,
  flags,
});

describe('InterpBuffer.sample', () => {
  it('returns null while empty', () => {
    expect(new InterpBuffer().sample(100)).toBeNull();
  });

  it('lerps position at the midpoint of a segment', () => {
    const b = new InterpBuffer();
    b.push(snap(1000, 0));
    b.push(snap(1100, 2));
    const s = b.sample(1050)!;
    expect(s.pos[0]).toBeCloseTo(1);
    // Segment velocity: 2 units over 100ms = 20 u/s.
    expect(s.velocity[0]).toBeCloseTo(20);
  });

  it('picks the correct segment among several', () => {
    const b = new InterpBuffer();
    b.push(snap(0, 0));
    b.push(snap(100, 10));
    b.push(snap(200, 10));
    b.push(snap(300, 40));
    expect(b.sample(250)!.pos[0]).toBeCloseTo(25);
    expect(b.sample(50)!.pos[0]).toBeCloseTo(5);
  });

  it('clamps before the first entry (velocity 0, no back-extrapolation)', () => {
    const b = new InterpBuffer();
    b.push(snap(1000, 5));
    b.push(snap(1100, 9));
    const s = b.sample(500)!;
    expect(s.pos[0]).toBe(5);
    expect(s.velocity).toEqual([0, 0, 0]);
  });

  it('holds the newest entry past the end (never extrapolates)', () => {
    const b = new InterpBuffer();
    b.push(snap(1000, 5));
    b.push(snap(1100, 9));
    const s = b.sample(9999)!;
    expect(s.pos[0]).toBe(9);
    expect(s.velocity).toEqual([0, 0, 0]);
  });

  it('drops out-of-order pushes and overwrites equal timestamps', () => {
    const b = new InterpBuffer();
    b.push(snap(100, 1));
    b.push(snap(200, 2));
    b.push(snap(150, 99)); // late packet — dropped
    expect(b.sample(175)!.pos[0]).toBeCloseTo(1.75);
    b.push(snap(200, 5)); // same-stamp overwrite
    expect(b.sample(200)!.pos[0]).toBe(5);
  });

  it('evicts oldest entries past capacity', () => {
    const b = new InterpBuffer(4);
    for (let i = 0; i < 10; i += 1) b.push(snap(i * 100, i));
    expect(b.size).toBe(4);
    // Oldest surviving entry is t=600 — sampling earlier clamps to it.
    expect(b.sample(0)!.pos[0]).toBe(6);
  });

  it('interpolates rotY along the shortest arc across the ±π seam', () => {
    const b = new InterpBuffer();
    b.push(snap(0, 0, Math.PI - 0.1));
    b.push(snap(100, 0, -Math.PI + 0.1));
    const mid = b.sample(50)!;
    // Shortest arc passes THROUGH π, not through 0.
    expect(Math.abs(mid.rotY)).toBeGreaterThan(3);
  });

  it('carries the newer endpoint flags through a segment', () => {
    const b = new InterpBuffer();
    b.push(snap(0, 0, 0, 0));
    b.push(snap(100, 1, 0, 3));
    expect(b.sample(50)!.flags).toBe(3);
  });

  it('prune drops stale history but keeps the buffer sampleable', () => {
    const b = new InterpBuffer();
    for (let i = 0; i < 8; i += 1) b.push(snap(i * 100, i));
    b.prune(550);
    expect(b.size).toBeLessThan(8);
    expect(b.sample(650)!.pos[0]).toBeCloseTo(6.5);
  });
});

describe('shortestArcLerp', () => {
  it('goes the short way around', () => {
    const r = shortestArcLerp(-Math.PI + 0.05, Math.PI - 0.05, 0.5);
    expect(Math.abs(r)).toBeCloseTo(Math.PI, 1);
  });

  it('is exact at the endpoints', () => {
    expect(shortestArcLerp(0.3, 1.1, 0)).toBeCloseTo(0.3);
    expect(shortestArcLerp(0.3, 1.1, 1)).toBeCloseTo(1.1);
  });
});
