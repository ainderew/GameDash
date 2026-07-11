import { describe, expect, it } from 'vitest';
import {
  DIRTY_ALL,
  DIRTY_POS,
  DIRTY_ROT,
  ENTITY_KIND,
  POS_QUANT_EPS,
  ROT_QUANT_EPS,
  VEL_QUANT_EPS,
  decodeSnapshot,
  encodeSnapshot,
  patchSnapshotAck,
  quantizeEntity,
  type QuantEntityState,
} from './snapshot';

const rng = (() => {
  let s = 7 >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
})();

const randPos = (): [number, number, number] => [rng() * 60 - 30, rng() * 10, rng() * 60 - 30];
const randVel = (): [number, number, number] => [rng() * 24 - 12, rng() * 14 - 7, rng() * 24 - 12];

const randomEntity = (id: number) =>
  quantizeEntity({
    id,
    kind: ENTITY_KIND.player,
    pos: randPos(),
    rotY: rng() * Math.PI * 4 - Math.PI * 2,
    hp: Math.floor(rng() * 1000),
    vel: randVel(),
    flags: Math.floor(rng() * 256),
  });

const header = (tick: number, baselineTick = tick) => ({
  serverTick: tick,
  baselineTick,
  serverTimeMs: tick * (1000 / 30),
  yourLastProcessedSeq: tick * 3 + 1,
  ackPos: randPos(),
  ackVel: randVel(),
  ackRotY: rng() * Math.PI * 2,
});

const wrapAngleDist = (a: number, b: number): number => {
  const TWO_PI = Math.PI * 2;
  let d = Math.abs((((a - b) % TWO_PI) + TWO_PI) % TWO_PI);
  if (d > Math.PI) d = TWO_PI - d;
  return d;
};

describe('snapshot codec', () => {
  it('keyframe round-trips every field within quantization epsilon (100 random frames)', () => {
    for (let i = 0; i < 100; i += 1) {
      const src = Array.from({ length: 1 + Math.floor(rng() * 12) }, (_, k) => randomEntity(k + 1));
      const h = header(i + 1);
      const decoded = decodeSnapshot(encodeSnapshot(h, src, null))!;
      expect(decoded).not.toBeNull();
      expect(decoded.header.keyframe).toBe(true);
      expect(decoded.header.serverTick).toBe(h.serverTick);
      expect(decoded.header.serverTimeMs).toBe(h.serverTimeMs);
      expect(decoded.header.yourLastProcessedSeq).toBe(h.yourLastProcessedSeq);
      for (let a = 0; a < 3; a += 1) {
        expect(Math.abs(decoded.header.ackPos[a]! - h.ackPos[a]!)).toBeLessThanOrEqual(POS_QUANT_EPS);
        expect(Math.abs(decoded.header.ackVel[a]! - h.ackVel[a]!)).toBeLessThanOrEqual(VEL_QUANT_EPS);
      }
      expect(wrapAngleDist(decoded.header.ackRotY, h.ackRotY)).toBeLessThanOrEqual(ROT_QUANT_EPS);

      expect(decoded.entities).toHaveLength(src.length);
      for (let k = 0; k < src.length; k += 1) {
        const d = decoded.entities[k]!;
        const s = src[k]!;
        expect(d.id).toBe(s.id);
        expect(d.kind).toBe(s.kind);
        expect(d.mask).toBe(DIRTY_ALL);
        // Decode(quantized) must reproduce the wire ints exactly.
        const requant = quantizeEntity({
          id: d.id,
          kind: d.kind,
          pos: d.pos!,
          rotY: d.rotY!,
          hp: d.hp!,
          vel: d.vel!,
          flags: d.flags!,
        });
        expect(requant).toEqual(s);
      }
    }
  });

  it('deltas carry ONLY fields that differ from the baseline; clean entities are omitted', () => {
    const a = randomEntity(1);
    const b = randomEntity(2);
    const baseline = new Map<number, QuantEntityState>([
      [1, a],
      [2, b],
    ]);
    const movedA: QuantEntityState = { ...a, px: a.px + 12, rot: (a.rot + 5) % 256 };
    const decoded = decodeSnapshot(encodeSnapshot(header(50, 40), [movedA, b], baseline))!;
    expect(decoded.header.keyframe).toBe(false);
    expect(decoded.header.baselineTick).toBe(40);
    expect(decoded.entities).toHaveLength(1); // b was clean → omitted
    const rec = decoded.entities[0]!;
    expect(rec.id).toBe(1);
    expect(rec.mask).toBe(DIRTY_POS | DIRTY_ROT);
    expect(rec.hp).toBeUndefined();
    expect(rec.vel).toBeUndefined();
  });

  it('entities unknown to the baseline are encoded in full inside a delta', () => {
    const a = randomEntity(1);
    const fresh = randomEntity(9);
    const baseline = new Map<number, QuantEntityState>([[1, a]]);
    const decoded = decodeSnapshot(encodeSnapshot(header(51, 40), [a, fresh], baseline))!;
    expect(decoded.entities).toHaveLength(1);
    expect(decoded.entities[0]!.id).toBe(9);
    expect(decoded.entities[0]!.mask).toBe(DIRTY_ALL);
  });

  it('per-recipient ack patch changes only the ack block', () => {
    const src = [randomEntity(1), randomEntity(2)];
    const buf = encodeSnapshot(header(60), src, null);
    const before = decodeSnapshot(buf)!;
    patchSnapshotAck(buf, 777, [1, 2, 3], [-4, 5, -6], 1.5);
    const after = decodeSnapshot(buf)!;
    expect(after.header.yourLastProcessedSeq).toBe(777);
    expect(after.header.ackPos[0]).toBeCloseTo(1, 2);
    expect(after.header.ackVel[2]).toBeCloseTo(-6, 3);
    expect(after.header.serverTick).toBe(before.header.serverTick);
    expect(after.entities).toEqual(before.entities);
  });

  it('rejects malformed frames instead of throwing', () => {
    expect(decodeSnapshot(new ArrayBuffer(0))).toBeNull();
    expect(decodeSnapshot(new Uint8Array([2, 0, 0]).buffer)).toBeNull(); // truncated header
    const good = encodeSnapshot(header(1), [randomEntity(1)], null);
    expect(decodeSnapshot(good.slice(0, good.byteLength - 2))).toBeNull(); // truncated record
    const extra = new Uint8Array(good.byteLength + 3);
    extra.set(new Uint8Array(good), 0);
    expect(decodeSnapshot(extra.buffer)).toBeNull(); // trailing garbage
  });

  it('BYTE BUDGET: 4 players + 60 monsters + 8 projectiles, all fields dirty, ≤ 1.5 KB', () => {
    const entities: QuantEntityState[] = [];
    let id = 1;
    for (let i = 0; i < 4; i += 1) entities.push({ ...randomEntity(id++), kind: ENTITY_KIND.player });
    for (let i = 0; i < 60; i += 1) entities.push({ ...randomEntity(id++), kind: ENTITY_KIND.monster });
    for (let i = 0; i < 8; i += 1) entities.push({ ...randomEntity(id++), kind: ENTITY_KIND.projectile });
    const buf = encodeSnapshot(header(100), entities, null); // keyframe = worst case
    expect(buf.byteLength).toBeLessThanOrEqual(1536);
    // ⇒ ≤ ~30 KB/s at 20 Hz worst case; typical deltas are a small fraction of this.
    const typical = encodeSnapshot(
      header(101, 100),
      entities.map((e, i) => (i % 4 === 0 ? { ...e, px: e.px + 3, vx: e.vx + 40 } : e)),
      new Map(entities.map((e) => [e.id, e])),
    );
    expect(typical.byteLength).toBeLessThan(buf.byteLength / 3);
  });
});
