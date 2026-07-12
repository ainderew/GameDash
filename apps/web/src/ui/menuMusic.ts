/**
 * MENU BACKGROUND MUSIC — the looping harp theme under the main menu ("The Harp in the
 * Ruined Hall"). A single reused HTMLAudioElement, faded in/out so entering and leaving the
 * menu never pops. The source file is loudness-normalized to -16 LUFS (same target as the
 * relic-pickup stinger), so the only mix control here is the ambient bed level scaled by the
 * master-volume slider.
 *
 * Browsers block autoplay until the user interacts with the page. We optimistically try to
 * play on mount; if that's rejected, we arm a one-shot pointer/key listener and start the
 * moment the player touches anything (a menu button click, a keypress — same unlock gesture
 * the rest of the audio pipeline relies on). Fully guarded so it no-ops in tests/SSR.
 */

import { feel } from '@/game/feel/config';

const TRACK_URL = '/audio/menu-theme.mp3';
/** Ambient bed level for the menu loop, before the master-volume slider scales it. */
const MENU_BGM_LEVEL = 0.55;
/** Fade duration for enter/leave, ms. Long enough to feel intentional, short enough to obey. */
const FADE_MS = 800;

let audio: HTMLAudioElement | null = null;
let gestureUnbind: (() => void) | null = null;
let fadeRaf: number | null = null;
/** Resolves once the track has buffered enough to play through (drives the menu loader). */
let readyPromise: Promise<void> | null = null;

const canRaf = (): boolean => typeof requestAnimationFrame !== 'undefined';

/** Create the shared audio element (idempotent). Kicks off buffering via preload='auto'. */
const ensureAudio = (): HTMLAudioElement | null => {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (!audio) {
    audio = new Audio(TRACK_URL);
    audio.loop = true;
    audio.preload = 'auto';
  }
  return audio;
};

/**
 * Preload the menu track and resolve when it can play through — or after `timeoutMs`, so a
 * browser that withholds `canplaythrough` (or a stalled network) never wedges the loader.
 * The music is not visually critical: the loading screen waits on it, but only briefly.
 */
export const whenMenuMusicReady = (timeoutMs = 8000): Promise<void> => {
  if (readyPromise) return readyPromise;
  const el = ensureAudio();
  if (!el) return Promise.resolve();
  readyPromise = new Promise<void>((resolve) => {
    if (el.readyState >= 4 /* HAVE_ENOUGH_DATA */) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('canplaythrough', finish);
      el.removeEventListener('loadeddata', finish);
      el.removeEventListener('error', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    el.addEventListener('canplaythrough', finish);
    el.addEventListener('loadeddata', finish); // fallback if canplaythrough is withheld
    el.addEventListener('error', finish); // don't block the menu on a missing/broken file
    el.load();
  });
  return readyPromise;
};

/** The volume the loop should currently sit at: 0 when audio is off, else bed × master. */
const targetVolume = (): number =>
  feel.audio.enabled ? MENU_BGM_LEVEL * feel.audio.masterVolume : 0;

const clearFade = (): void => {
  if (fadeRaf !== null) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = null;
  }
};

/** Ramp the element's volume toward `to` over FADE_MS, optionally pausing once silent. */
const fadeTo = (to: number, thenPause = false): void => {
  if (!audio) return;
  clearFade();
  const el = audio;
  if (!canRaf()) {
    el.volume = to;
    if (thenPause && to <= 0) el.pause();
    return;
  }
  const from = el.volume;
  const start = performance.now();
  const step = (nowMs: number): void => {
    const t = Math.min(1, (nowMs - start) / FADE_MS);
    el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (t < 1) {
      fadeRaf = requestAnimationFrame(step);
    } else {
      fadeRaf = null;
      if (thenPause) el.pause();
    }
  };
  fadeRaf = requestAnimationFrame(step);
};

/** Arm a one-shot gesture listener that starts the loop the next time the player interacts. */
const bindGesture = (): void => {
  if (gestureUnbind || typeof window === 'undefined') return;
  const onGesture = (): void => {
    if (!audio) return;
    void audio
      .play()
      .then(() => {
        unbindGesture();
        fadeTo(targetVolume());
      })
      .catch(() => undefined);
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  gestureUnbind = () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    gestureUnbind = null;
  };
};

const unbindGesture = (): void => {
  gestureUnbind?.();
};

/** Start (or resume) the menu loop, fading it in. Safe to call repeatedly. */
export const startMenuMusic = (): void => {
  if (!ensureAudio() || !audio) return;
  clearFade();
  audio.volume = 0;
  void audio
    .play()
    .then(() => fadeTo(targetVolume()))
    .catch(() => bindGesture()); // autoplay blocked — wait for the first gesture
};

/** Stop the menu loop, fading it out. Called when the menu unmounts (Play, intro, hub). */
export const stopMenuMusic = (): void => {
  unbindGesture();
  if (!audio) return;
  fadeTo(0, true);
};

/**
 * Re-read feel.audio after the Settings toggle/slider changes: snap to the new level, and
 * pause/unpause so muting the game silences the menu bed immediately.
 */
export const syncMenuMusic = (): void => {
  if (!audio) return;
  clearFade();
  audio.volume = targetVolume();
  if (feel.audio.enabled) {
    if (audio.paused) void audio.play().catch(() => bindGesture());
  } else {
    audio.pause();
  }
};
