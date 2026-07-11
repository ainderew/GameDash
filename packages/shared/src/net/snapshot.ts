/**
 * Binary snapshot codec (Phase 3, Task 3). Flat DataView layout, dirty masks, quantized
 * fields. Deltas are STATELESS against the last keyframe baseline (identified by
 * `baselineTick`): every delta is decodable from the keyframe alone, so a delayed/skipped
 * delta never corrupts the stream. Keyframes repeat everything and are authoritative for
 * entity existence.
 *
 * Layout (little-endian):
 *   u8  MSG_SNAPSHOT
 *   u8  flags (bit0 = keyframe)
 *   u32 serverTick
 *   u32 baselineTick          — keyframe tick this delta diffs against (== serverTick on keyframes)
 *   f64 serverTimeMs          — serverTick × MS_PER_TICK (the shared interp timeline)
 *   u32 yourLastProcessedSeq  — per-recipient input ack
 *   ── your authoritative state CAPTURED AT that seq's tick (uncontaminated by later
 *      starvation-coast ticks — reconciliation always compares apples to apples):
 *   3×i16 ackPos (cm) · 3×i16 ackVel (mm/s) · u8 ackRotY
 *   u16 entityCount
 *   per entity:
 *     u16 id · u8 kind · u8 mask
 *     [POS]   3×i16 position, centimeters
 *     [ROT]   u8 rotY, [0,2π)/256
 *     [HP]    u16
 *     [VEL]   3×i16 velocity, mm/s
 *     [FLAGS] u8 anim flags
 */

export const MSG_SNAPSHOT = 2;

export const SNAP_KEYFRAME = 1 << 0;

// ── Field dirty mask ──────────────────────────────────────────────────────────
export const DIRTY_POS = 1 << 0;
export const DIRTY_ROT = 1 << 1;
export const DIRTY_HP = 1 << 2;
export const DIRTY_VEL = 1 << 3;
export const DIRTY_FLAGS = 1 << 4;
export const DIRTY_ALL = DIRTY_POS | DIRTY_ROT | DIRTY_HP | DIRTY_VEL | DIRTY_FLAGS;

/** What an entity is — snapshot records carry no component data beyond this. */
export const ENTITY_KIND = {
  player: 0,
  monster: 1,
  projectile: 2,
  relic: 3,
  pickup: 4,
} as const;
export type EntityKind = (typeof ENTITY_KIND)[keyof typeof ENTITY_KIND];

// ── Quantization (wire integers) ─────────────────────────────────────────────
const POS_SCALE = 100; // int16 centimeters → ±327 m
const VEL_SCALE = 1000; // int16 mm/s → ±32.7 m/s (dodge dash peaks at 22.2)
const ROT_STEPS = 256;
const TWO_PI = Math.PI * 2;

const clampI16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

export const quantPos = (m: number): number => clampI16(m * POS_SCALE);
export const dequantPos = (q: number): number => q / POS_SCALE;
export const quantVel = (v: number): number => clampI16(v * VEL_SCALE);
export const dequantVel = (q: number): number => q / VEL_SCALE;
export const quantRot = (rad: number): number => {
  const norm = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((norm / TWO_PI) * ROT_STEPS) % ROT_STEPS;
};
export const dequantRot = (q: number): number => (q / ROT_STEPS) * TWO_PI;

/** Worst-case decode errors — reconciliation epsilons must sit ABOVE these. */
export const POS_QUANT_EPS = 0.5 / POS_SCALE + 1e-9; // 0.5 cm
export const VEL_QUANT_EPS = 0.5 / VEL_SCALE + 1e-9;
export const ROT_QUANT_EPS = TWO_PI / ROT_STEPS / 2 + 1e-9;

/** An entity's snapshot state in WIRE integers — baselines compare these exactly. */
export interface QuantEntityState {
  id: number;
  kind: EntityKind;
  px: number;
  py: number;
  pz: number;
  rot: number;
  hp: number;
  vx: number;
  vy: number;
  vz: number;
  flags: number;
}

/** Quantize world-unit state into wire ints (the server does this once per snapshot). */
export const quantizeEntity = (e: {
  id: number;
  kind: EntityKind;
  pos: readonly [number, number, number];
  rotY: number;
  hp: number;
  vel: readonly [number, number, number];
  flags: number;
}): QuantEntityState => ({
  id: e.id,
  kind: e.kind,
  px: quantPos(e.pos[0]),
  py: quantPos(e.pos[1]),
  pz: quantPos(e.pos[2]),
  rot: quantRot(e.rotY),
  hp: Math.max(0, Math.min(0xffff, Math.round(e.hp))),
  vx: quantVel(e.vel[0]),
  vy: quantVel(e.vel[1]),
  vz: quantVel(e.vel[2]),
  flags: e.flags & 0xff,
});

export interface SnapshotHeader {
  keyframe: boolean;
  serverTick: number;
  baselineTick: number;
  serverTimeMs: number;
  yourLastProcessedSeq: number;
  /** Your avatar's authoritative state at the tick your last cmd was processed. */
  ackPos: [number, number, number];
  ackVel: [number, number, number];
  ackRotY: number;
}

/** A decoded record: only masked fields are present (dequantized to world units). */
export interface DecodedEntityRecord {
  id: number;
  kind: EntityKind;
  mask: number;
  pos?: [number, number, number];
  rotY?: number;
  hp?: number;
  vel?: [number, number, number];
  flags?: number;
}

export interface DecodedSnapshot {
  header: SnapshotHeader;
  entities: DecodedEntityRecord[];
}

const HEADER_BYTES = 1 + 1 + 4 + 4 + 8 + 4 + 6 + 6 + 1 + 2; // 37
const RECORD_FIXED = 4; // id + kind + mask

const maskBytes = (mask: number): number =>
  (mask & DIRTY_POS ? 6 : 0) +
  (mask & DIRTY_ROT ? 1 : 0) +
  (mask & DIRTY_HP ? 2 : 0) +
  (mask & DIRTY_VEL ? 6 : 0) +
  (mask & DIRTY_FLAGS ? 1 : 0);

const dirtyVs = (cur: QuantEntityState, base: QuantEntityState | undefined): number => {
  if (!base) return DIRTY_ALL; // spawned since the keyframe → full record
  let mask = 0;
  if (cur.px !== base.px || cur.py !== base.py || cur.pz !== base.pz) mask |= DIRTY_POS;
  if (cur.rot !== base.rot) mask |= DIRTY_ROT;
  if (cur.hp !== base.hp) mask |= DIRTY_HP;
  if (cur.vx !== base.vx || cur.vy !== base.vy || cur.vz !== base.vz) mask |= DIRTY_VEL;
  if (cur.flags !== base.flags) mask |= DIRTY_FLAGS;
  return mask;
};

/**
 * Encode one snapshot. `baseline` null ⇒ keyframe (all fields, all entities).
 * With a baseline, entities whose every field matches it are omitted entirely.
 */
export const encodeSnapshot = (
  header: Omit<SnapshotHeader, 'keyframe'>,
  entities: readonly QuantEntityState[],
  baseline: ReadonlyMap<number, QuantEntityState> | null,
): ArrayBuffer => {
  const keyframe = baseline === null;
  const records: { e: QuantEntityState; mask: number }[] = [];
  for (const e of entities) {
    const mask = keyframe ? DIRTY_ALL : dirtyVs(e, baseline.get(e.id));
    if (mask !== 0 || keyframe) records.push({ e, mask: keyframe ? DIRTY_ALL : mask });
  }

  let size = HEADER_BYTES;
  for (const r of records) size += RECORD_FIXED + maskBytes(r.mask);

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint8(0, MSG_SNAPSHOT);
  view.setUint8(1, keyframe ? SNAP_KEYFRAME : 0);
  view.setUint32(2, header.serverTick >>> 0, true);
  view.setUint32(6, header.baselineTick >>> 0, true);
  view.setFloat64(10, header.serverTimeMs, true);
  view.setUint32(18, header.yourLastProcessedSeq >>> 0, true);
  view.setInt16(22, quantPos(header.ackPos[0]), true);
  view.setInt16(24, quantPos(header.ackPos[1]), true);
  view.setInt16(26, quantPos(header.ackPos[2]), true);
  view.setInt16(28, quantVel(header.ackVel[0]), true);
  view.setInt16(30, quantVel(header.ackVel[1]), true);
  view.setInt16(32, quantVel(header.ackVel[2]), true);
  view.setUint8(34, quantRot(header.ackRotY));
  view.setUint16(35, records.length, true);

  let off = HEADER_BYTES;
  for (const { e, mask } of records) {
    view.setUint16(off, e.id & 0xffff, true);
    view.setUint8(off + 2, e.kind);
    view.setUint8(off + 3, mask);
    off += RECORD_FIXED;
    if (mask & DIRTY_POS) {
      view.setInt16(off, e.px, true);
      view.setInt16(off + 2, e.py, true);
      view.setInt16(off + 4, e.pz, true);
      off += 6;
    }
    if (mask & DIRTY_ROT) {
      view.setUint8(off, e.rot);
      off += 1;
    }
    if (mask & DIRTY_HP) {
      view.setUint16(off, e.hp, true);
      off += 2;
    }
    if (mask & DIRTY_VEL) {
      view.setInt16(off, e.vx, true);
      view.setInt16(off + 2, e.vy, true);
      view.setInt16(off + 4, e.vz, true);
      off += 6;
    }
    if (mask & DIRTY_FLAGS) {
      view.setUint8(off, e.flags);
      off += 1;
    }
  }
  return buf;
};

/**
 * Patch the per-recipient header fields into a shared encoded snapshot (records are
 * identical for every client; only the ack block differs). Mutates `buf` in place.
 */
export const patchSnapshotAck = (
  buf: ArrayBuffer,
  yourLastProcessedSeq: number,
  ackPos: readonly [number, number, number],
  ackVel: readonly [number, number, number],
  ackRotY: number,
): void => {
  const view = new DataView(buf);
  view.setUint32(18, yourLastProcessedSeq >>> 0, true);
  view.setInt16(22, quantPos(ackPos[0]), true);
  view.setInt16(24, quantPos(ackPos[1]), true);
  view.setInt16(26, quantPos(ackPos[2]), true);
  view.setInt16(28, quantVel(ackVel[0]), true);
  view.setInt16(30, quantVel(ackVel[1]), true);
  view.setInt16(32, quantVel(ackVel[2]), true);
  view.setUint8(34, quantRot(ackRotY));
};

/** Decode a snapshot frame. Returns null on malformed input. */
export const decodeSnapshot = (buf: ArrayBufferLike): DecodedSnapshot | null => {
  const view = new DataView(buf);
  if (view.byteLength < HEADER_BYTES || view.getUint8(0) !== MSG_SNAPSHOT) return null;
  const flags = view.getUint8(1);
  const header: SnapshotHeader = {
    keyframe: (flags & SNAP_KEYFRAME) !== 0,
    serverTick: view.getUint32(2, true),
    baselineTick: view.getUint32(6, true),
    serverTimeMs: view.getFloat64(10, true),
    yourLastProcessedSeq: view.getUint32(18, true),
    ackPos: [
      dequantPos(view.getInt16(22, true)),
      dequantPos(view.getInt16(24, true)),
      dequantPos(view.getInt16(26, true)),
    ],
    ackVel: [
      dequantVel(view.getInt16(28, true)),
      dequantVel(view.getInt16(30, true)),
      dequantVel(view.getInt16(32, true)),
    ],
    ackRotY: dequantRot(view.getUint8(34)),
  };
  const count = view.getUint16(35, true);

  const entities: DecodedEntityRecord[] = [];
  let off = HEADER_BYTES;
  try {
    for (let i = 0; i < count; i += 1) {
      const id = view.getUint16(off, true);
      const kind = view.getUint8(off + 2) as EntityKind;
      const mask = view.getUint8(off + 3);
      off += RECORD_FIXED;
      const rec: DecodedEntityRecord = { id, kind, mask };
      if (mask & DIRTY_POS) {
        rec.pos = [
          dequantPos(view.getInt16(off, true)),
          dequantPos(view.getInt16(off + 2, true)),
          dequantPos(view.getInt16(off + 4, true)),
        ];
        off += 6;
      }
      if (mask & DIRTY_ROT) {
        rec.rotY = dequantRot(view.getUint8(off));
        off += 1;
      }
      if (mask & DIRTY_HP) {
        rec.hp = view.getUint16(off, true);
        off += 2;
      }
      if (mask & DIRTY_VEL) {
        rec.vel = [
          dequantVel(view.getInt16(off, true)),
          dequantVel(view.getInt16(off + 2, true)),
          dequantVel(view.getInt16(off + 4, true)),
        ];
        off += 6;
      }
      if (mask & DIRTY_FLAGS) {
        rec.flags = view.getUint8(off);
        off += 1;
      }
      entities.push(rec);
    }
  } catch {
    return null; // truncated frame
  }
  if (off !== view.byteLength) return null;
  return { header, entities };
};
