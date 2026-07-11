/**
 * Binary InputCmd pipeline (Phase 3, Task 1). The client sends ONLY intent — never state.
 * Every packet carries the last INPUT_REDUNDANCY cmds so a single lost/late packet costs
 * nothing (no-rubberband contract #2). Codec lives here, imported by BOTH sides and
 * round-trip tested — never hand-duplicated.
 *
 * Layout (little-endian):
 *   u8  MSG_INPUT
 *   u8  count (1..INPUT_REDUNDANCY)
 *   per cmd (20 bytes):
 *     u32 seq              — client cmd sequence, 1-based, gapless
 *     u32 clientTick       — sender's fixed-tick index (diagnostics/jitter metrics only;
 *                            the server NEVER simulates on client time)
 *     i8  moveX, moveZ     — world-space move dir × 100 (camera rotation already applied
 *                            client-side, so the server needs no camera state)
 *     u16 buttons          — BTN_* bitmask
 *     u16 aimYaw           — facing/aim yaw quantized to [0, 2π) / 65536 (combat, Phase 4)
 *     u16 passTargetId     — entity id of a pass receiver; 0 = none (relic, Phase 5)
 *     u32 viewServerTimeMs — client's interpolated render time on the shared server
 *                            timeline, ms (÷ MS_PER_TICK server-side → a tick to rewind to).
 *                            Lets the server rewind hittable entities to WHAT THE ATTACKER
 *                            SAW (lag-compensated melee, Phase 4 Task 3).
 */

/**
 * Structurally identical to @friendslop/sim's `InputIntent` (TS matches structurally, and
 * shared must not depend on sim). The decoded intent feeds `applyPlayerIntent` directly.
 */
export interface MoveIntent {
  moveX: number;
  moveZ: number;
  jump: boolean;
  dodge: boolean;
  sprint: boolean;
}

export const MSG_INPUT = 1;

/** How many trailing cmds each packet repeats (self-healing under loss). */
export const INPUT_REDUNDANCY = 3;

// ── Button bitmask (buttons is u16 — bits 0–15 available) ──────────────────────
export const BTN_JUMP = 1 << 0;
export const BTN_SPRINT = 1 << 1;
export const BTN_DODGE = 1 << 2;
export const BTN_MELEE = 1 << 3;
export const BTN_RANGED = 1 << 4;
export const BTN_PARRY = 1 << 5;
export const BTN_PASS_HOLD = 1 << 6;
export const BTN_DROP = 1 << 7;
/** Holding the revive input near a downed teammate (co-op revive, Phase 4). */
export const BTN_REVIVE = 1 << 8;

export interface InputCmd {
  seq: number;
  clientTick: number;
  /** Quantized ints as sent on the wire (÷100 = world dir). */
  moveX: number;
  moveZ: number;
  buttons: number;
  aimYaw: number;
  passTargetId: number;
  /** Client's interpolated render time on the shared server timeline, ms (lag-comp). */
  viewServerTimeMs: number;
}

const CMD_BYTES = 20;
const MOVE_SCALE = 100;
const YAW_SCALE = 65536;
const TWO_PI = Math.PI * 2;

/** Quantize a (pre-normalized) world move component to the wire int8. */
export const quantizeMove = (v: number): number =>
  Math.max(-127, Math.min(127, Math.round(v * MOVE_SCALE)));

/** Quantize an aim yaw (radians) to the wire u16 ([0, 2π) → 0..65535). */
export const quantizeYaw = (rad: number): number => {
  const norm = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((norm / TWO_PI) * YAW_SCALE) % YAW_SCALE;
};
export const dequantizeYaw = (q: number): number => (q / YAW_SCALE) * TWO_PI;

/** The full per-tick intent a client encodes: movement + combat verbs + aim + view time. */
export interface CmdIntent extends MoveIntent {
  melee?: boolean;
  ranged?: boolean;
  parry?: boolean;
  drop?: boolean;
  passHold?: boolean;
  revive?: boolean;
  /** Aim yaw in radians (facing at swing/shot start). */
  aimYaw?: number;
  passTargetId?: number;
  /** Interpolated render time on the shared server timeline, ms. */
  viewServerTimeMs?: number;
}

/** Combat + aim verbs decoded from a cmd — fed alongside the MoveIntent into the sim. */
export interface CombatIntent {
  melee: boolean;
  ranged: boolean;
  parry: boolean;
  drop: boolean;
  passHold: boolean;
  revive: boolean;
  aimYaw: number;
  passTargetId: number;
  viewServerTimeMs: number;
}

/** Build a wire cmd from a full intent (movement + combat, Phase 4). */
export const makeInputCmd = (seq: number, clientTick: number, intent: CmdIntent): InputCmd => ({
  seq,
  clientTick,
  moveX: quantizeMove(intent.moveX),
  moveZ: quantizeMove(intent.moveZ),
  buttons:
    (intent.jump ? BTN_JUMP : 0) |
    (intent.sprint ? BTN_SPRINT : 0) |
    (intent.dodge ? BTN_DODGE : 0) |
    (intent.melee ? BTN_MELEE : 0) |
    (intent.ranged ? BTN_RANGED : 0) |
    (intent.parry ? BTN_PARRY : 0) |
    (intent.passHold ? BTN_PASS_HOLD : 0) |
    (intent.drop ? BTN_DROP : 0) |
    (intent.revive ? BTN_REVIVE : 0),
  aimYaw: quantizeYaw(intent.aimYaw ?? 0),
  passTargetId: (intent.passTargetId ?? 0) & 0xffff,
  viewServerTimeMs: Math.max(0, Math.round(intent.viewServerTimeMs ?? 0)) >>> 0,
});

/**
 * Decode a cmd into the movement intent BOTH the server sim and the client prediction run.
 * SANITY CLAMP lives here (single implementation): the move vector is renormalized when
 * its magnitude exceeds 1 — a speed-hacked client crafting (127,127) still moves at 1×.
 * Client prediction MUST use this decoded intent (not its raw float input) so prediction
 * and authority quantize identically — corrections ≈ 0 by construction.
 */
export const intentFromCmd = (cmd: InputCmd): MoveIntent => {
  let moveX = cmd.moveX / MOVE_SCALE;
  let moveZ = cmd.moveZ / MOVE_SCALE;
  const len = Math.hypot(moveX, moveZ);
  if (len > 1) {
    moveX /= len;
    moveZ /= len;
  }
  return {
    moveX,
    moveZ,
    jump: (cmd.buttons & BTN_JUMP) !== 0,
    sprint: (cmd.buttons & BTN_SPRINT) !== 0,
    dodge: (cmd.buttons & BTN_DODGE) !== 0,
  };
};

/** Decode the combat/aim verbs from a cmd (server + client prediction consume both). */
export const combatFromCmd = (cmd: InputCmd): CombatIntent => ({
  melee: (cmd.buttons & BTN_MELEE) !== 0,
  ranged: (cmd.buttons & BTN_RANGED) !== 0,
  parry: (cmd.buttons & BTN_PARRY) !== 0,
  drop: (cmd.buttons & BTN_DROP) !== 0,
  passHold: (cmd.buttons & BTN_PASS_HOLD) !== 0,
  revive: (cmd.buttons & BTN_REVIVE) !== 0,
  aimYaw: dequantizeYaw(cmd.aimYaw),
  passTargetId: cmd.passTargetId,
  viewServerTimeMs: cmd.viewServerTimeMs,
});

/** Encode the trailing window of cmds (newest last) into one binary packet. */
export const encodeInputPacket = (cmds: readonly InputCmd[]): ArrayBuffer => {
  const count = Math.min(cmds.length, INPUT_REDUNDANCY);
  const slice = cmds.slice(cmds.length - count);
  const buf = new ArrayBuffer(2 + count * CMD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG_INPUT);
  view.setUint8(1, count);
  let off = 2;
  for (const cmd of slice) {
    view.setUint32(off, cmd.seq >>> 0, true);
    view.setUint32(off + 4, cmd.clientTick >>> 0, true);
    view.setInt8(off + 8, cmd.moveX);
    view.setInt8(off + 9, cmd.moveZ);
    view.setUint16(off + 10, cmd.buttons & 0xffff, true);
    view.setUint16(off + 12, cmd.aimYaw & 0xffff, true);
    view.setUint16(off + 14, cmd.passTargetId & 0xffff, true);
    view.setUint32(off + 16, cmd.viewServerTimeMs >>> 0, true);
    off += CMD_BYTES;
  }
  return buf;
};

/** Decode a packet. Returns null on malformed frames (hostile clients must not crash). */
export const decodeInputPacket = (buf: ArrayBufferLike): InputCmd[] | null => {
  const view = new DataView(buf);
  if (view.byteLength < 2 || view.getUint8(0) !== MSG_INPUT) return null;
  const count = view.getUint8(1);
  if (count < 1 || count > INPUT_REDUNDANCY || view.byteLength !== 2 + count * CMD_BYTES) {
    return null;
  }
  const cmds: InputCmd[] = [];
  let off = 2;
  for (let i = 0; i < count; i += 1) {
    cmds.push({
      seq: view.getUint32(off, true),
      clientTick: view.getUint32(off + 4, true),
      moveX: view.getInt8(off + 8),
      moveZ: view.getInt8(off + 9),
      buttons: view.getUint16(off + 10, true),
      aimYaw: view.getUint16(off + 12, true),
      passTargetId: view.getUint16(off + 14, true),
      viewServerTimeMs: view.getUint32(off + 16, true),
    });
    off += CMD_BYTES;
  }
  return cmds;
};
