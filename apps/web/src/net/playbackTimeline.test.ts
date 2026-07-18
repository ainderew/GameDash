import { describe, expect, it } from 'vitest';
import { PlaybackTimeline } from '@/net/playbackTimeline';

describe('PlaybackTimeline', () => {
  it('never reverses when adaptive interpolation delay grows abruptly', () => {
    const timeline = new PlaybackTimeline(0.1);
    expect(timeline.sample(900, 1000)).toBe(900);

    const next = timeline.sample(836, 1016);
    expect(next).toBeGreaterThan(900);
    expect(next).toBeCloseTo(914.4);
  });

  it('slews forward instead of jumping when the clock estimate improves', () => {
    const timeline = new PlaybackTimeline(0.1);
    timeline.sample(900, 1000);
    expect(timeline.sample(966, 1016)).toBeCloseTo(917.6);
  });

  it('resets across a genuine server-timeline discontinuity', () => {
    const timeline = new PlaybackTimeline(0.1, 500);
    timeline.sample(900, 1000);
    expect(timeline.sample(2000, 1016)).toBe(2000);
  });
});
