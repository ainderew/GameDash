/**
 * AMBIENT SCHEDULER — fires the ambient world bed (playAmbient) at randomized gaps so the horror
 * swells drift through the world unpredictably instead of on an obvious loop. A self-rescheduling
 * setTimeout (not a fixed setInterval) so every gap is fresh, and it skips firing while the tab
 * is hidden so a backgrounded game doesn't queue up a burst of swells that all land on return.
 *
 * Mirrors menuMusic.ts: start when the game world mounts, stop when it unmounts (see AmbientAudio
 * driver). Fully guarded so it no-ops in tests/SSR. Volume/mute are handled downstream in
 * playAmbient (it reads feel.audio), so this only owns the timing.
 */

import { playAmbient } from '@/game/feel/audio';

/** Gap between swells. Wide + random so the pattern never becomes predictable. */
const MIN_GAP_MS = 50_000;
const MAX_GAP_MS = 110_000;
/** First swell arrives sooner than a full gap so the world feels alive shortly after entering. */
const FIRST_GAP_MS = 20_000;
const FIRST_GAP_JITTER_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const nextGap = (): number => MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);

const schedule = (delayMs: number): void => {
  if (typeof window === 'undefined') return;
  timer = setTimeout(tick, delayMs);
};

const tick = (): void => {
  if (!running) return;
  // Don't play into a hidden tab; the next tick after it's foregrounded picks it back up.
  if (typeof document === 'undefined' || !document.hidden) {
    playAmbient();
  }
  schedule(nextGap());
};

/** Begin the periodic ambient bed. Safe to call repeatedly (idempotent while running). */
export const startAmbient = (): void => {
  if (running || typeof window === 'undefined') return;
  running = true;
  schedule(FIRST_GAP_MS + Math.random() * FIRST_GAP_JITTER_MS);
};

/** Stop scheduling further swells (an in-flight swell finishes on its own). */
export const stopAmbient = (): void => {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};
