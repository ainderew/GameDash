import { describe, expect, it } from 'vitest';
import { consumeInputEdges, type InputState } from './useInput';

describe('consumeInputEdges', () => {
  it('preserves held pass/revive/movement inputs across multiplayer fixed ticks', () => {
    const input: InputState = {
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: true,
      dodge: false,
      sprint: true,
      melee: true,
      ranged: true,
      parry: true,
      skill1: true,
      pass: true,
      drop: true,
      revive: true,
    };

    consumeInputEdges(input);

    expect(input).toMatchObject({
      forward: true,
      sprint: true,
      pass: true,
      revive: true,
      jump: false,
      melee: false,
      ranged: false,
      parry: false,
      skill1: false,
      drop: false,
    });
  });
});
