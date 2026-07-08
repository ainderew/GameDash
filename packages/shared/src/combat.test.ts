import { describe, expect, it } from 'vitest';
import { computeDamage, isInIFrames, isHostile } from './combat';

describe('computeDamage', () => {
  it('returns the base when no modifiers', () => {
    expect(computeDamage(34)).toBe(34);
  });

  it('applies percentage then flat', () => {
    expect(computeDamage(100, { bonusPct: 0.2, flat: 5 })).toBe(125);
  });

  it('doubles on crit', () => {
    expect(computeDamage(50, { crit: true })).toBe(100);
  });

  it('never returns negative', () => {
    expect(computeDamage(10, { flat: -999 })).toBe(0);
  });

  it('rounds to an integer', () => {
    expect(computeDamage(33, { bonusPct: 0.1 })).toBe(36);
  });
});

describe('isInIFrames', () => {
  it('is true while the window is open', () => {
    expect(isInIFrames({ iframeUntil: 1000 }, 500)).toBe(true);
  });

  it('is false after the window closes', () => {
    expect(isInIFrames({ iframeUntil: 1000 }, 1000)).toBe(false);
    expect(isInIFrames({ iframeUntil: 1000 }, 1200)).toBe(false);
  });

  it('is false with no i-frame field', () => {
    expect(isInIFrames({}, 500)).toBe(false);
  });
});

describe('isHostile', () => {
  it('opposing factions are hostile', () => {
    expect(isHostile('player', 'monster')).toBe(true);
  });
  it('same faction is not hostile', () => {
    expect(isHostile('monster', 'monster')).toBe(false);
  });
});
