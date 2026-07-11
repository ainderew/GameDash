import { describe, expect, it } from 'vitest';
import {
  BTN_DODGE,
  BTN_JUMP,
  BTN_SPRINT,
  decodeInputPacket,
  encodeInputPacket,
  intentFromCmd,
  makeInputCmd,
  INPUT_REDUNDANCY,
  type InputCmd,
} from './input';

const rng = (() => {
  let s = 42 >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
})();

const randomCmd = (seq: number): InputCmd => ({
  seq,
  clientTick: Math.floor(rng() * 0xffffffff),
  moveX: Math.floor(rng() * 255) - 127,
  moveZ: Math.floor(rng() * 255) - 127,
  buttons: Math.floor(rng() * 0x10000),
  aimYaw: Math.floor(rng() * 0x10000),
  passTargetId: Math.floor(rng() * 0x10000),
});

describe('input codec', () => {
  it('round-trips random cmd windows exactly (500 packets)', () => {
    for (let i = 0; i < 500; i += 1) {
      const count = 1 + Math.floor(rng() * INPUT_REDUNDANCY);
      const cmds = Array.from({ length: count }, (_, k) => randomCmd(i * 10 + k + 1));
      const decoded = decodeInputPacket(encodeInputPacket(cmds));
      expect(decoded).toEqual(cmds);
    }
  });

  it('sends only the trailing INPUT_REDUNDANCY cmds of a longer ring', () => {
    const cmds = Array.from({ length: 7 }, (_, k) => randomCmd(k + 1));
    const decoded = decodeInputPacket(encodeInputPacket(cmds))!;
    expect(decoded.map((c) => c.seq)).toEqual([5, 6, 7]);
  });

  it('rejects malformed frames instead of throwing', () => {
    expect(decodeInputPacket(new ArrayBuffer(0))).toBeNull();
    expect(decodeInputPacket(new Uint8Array([1, 0]).buffer)).toBeNull(); // count 0
    expect(decodeInputPacket(new Uint8Array([1, 4]).buffer)).toBeNull(); // count > redundancy
    expect(decodeInputPacket(new Uint8Array([1, 1, 9]).buffer)).toBeNull(); // truncated
    expect(decodeInputPacket(new Uint8Array([2, 1]).buffer)).toBeNull(); // wrong type
  });

  it('quantizes intents with ≤0.01 error and decodes buttons', () => {
    const intent = { moveX: 0.7071, moveZ: -0.7071, jump: true, dodge: false, sprint: true };
    const cmd = makeInputCmd(9, 9, intent);
    expect(cmd.buttons & BTN_JUMP).toBeTruthy();
    expect(cmd.buttons & BTN_SPRINT).toBeTruthy();
    expect(cmd.buttons & BTN_DODGE).toBeFalsy();
    const back = intentFromCmd(cmd);
    expect(back.moveX).toBeCloseTo(intent.moveX, 2);
    expect(back.moveZ).toBeCloseTo(intent.moveZ, 2);
    expect(back).toMatchObject({ jump: true, dodge: false, sprint: true });
  });

  it('SANITY-CLAMPS speed-hacked vectors: (127,127) decodes to magnitude exactly 1', () => {
    const hacked: InputCmd = { seq: 1, clientTick: 1, moveX: 127, moveZ: 127, buttons: 0, aimYaw: 0, passTargetId: 0 };
    const intent = intentFromCmd(hacked);
    expect(Math.hypot(intent.moveX, intent.moveZ)).toBeCloseTo(1, 10);
    // Legit unit vectors survive un-renormalized (quantization ≤ 1 never triggers it).
    const legit = intentFromCmd(makeInputCmd(2, 2, { moveX: 0.6, moveZ: 0.8, jump: false, dodge: false, sprint: false }));
    expect(Math.hypot(legit.moveX, legit.moveZ)).toBeLessThanOrEqual(1.0001);
  });
});
