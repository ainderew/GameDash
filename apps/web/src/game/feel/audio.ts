/**
 * IMPACT AUDIO — procedural, no asset files. Audio is ~half the feel, so every hit is a
 * layered synth: a sharp high transient (the "crack") stacked on a low body thump with a
 * quick downward pitch bend (the "weight"). Light vs heavy differ in pitch, gain, and
 * decay so you can tell them apart with your eyes closed. A filtered-noise whoosh plays on
 * the swing itself so a miss still feels like effort.
 *
 * Everything is built on one lazily-created AudioContext, resumed on the first user
 * gesture (browsers block audio until then). Fully guarded so it no-ops in tests/SSR.
 */

import { feel, type HitStrength } from '@/game/feel/config';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;

const supported = (): boolean =>
  typeof window !== 'undefined' &&
  (typeof AudioContext !== 'undefined' ||
    typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !==
      'undefined');

/** Lazily build the context + master bus. Returns null when audio isn't available. */
const engine = (): Ctx | null => {
  if (!supported()) return null;
  if (!ctx) {
    const Ctor =
      AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = feel.audio.masterVolume;
    master.connect(ctx.destination);
  }
  return ctx;
};

/**
 * Resume the audio context — call from a user-gesture handler (mousedown/keydown).
 * No-op until the browser allows it.
 */
export const resumeAudio = (): void => {
  const c = engine();
  if (c && c.state === 'suspended') void c.resume();
};

/** Short reusable white-noise buffer for transients + whooshes. */
let noiseBuf: AudioBuffer | null = null;
const noiseBuffer = (c: Ctx): AudioBuffer => {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
};

const now = (c: Ctx): number => c.currentTime;

/** Play the layered punch for a landed hit. */
export const playHit = (strength: HitStrength, crit = false): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  master.gain.value = feel.audio.masterVolume;
  const heavy = strength === 'heavy';
  const t = now(c);

  // ── Low body thump: a sine that bends downward = weight/impact. ──
  const bodyGain = c.createGain();
  bodyGain.connect(master);
  const body = c.createOscillator();
  body.type = 'sine';
  const startHz = heavy ? 190 : 260;
  const endHz = heavy ? 46 : 90;
  body.frequency.setValueAtTime(startHz, t);
  body.frequency.exponentialRampToValueAtTime(endHz, t + (heavy ? 0.16 : 0.09));
  const bodyPeak = (heavy ? 0.9 : 0.55) * (crit ? 1.2 : 1);
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + (heavy ? 0.34 : 0.18));
  body.connect(bodyGain);
  body.start(t);
  body.stop(t + 0.4);

  // ── Sharp high transient: a fast band-passed noise crack = the "hit reads". ──
  const crackGain = c.createGain();
  crackGain.connect(master);
  const crack = c.createBufferSource();
  crack.buffer = noiseBuffer(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = heavy ? 1800 : 3200;
  bp.Q.value = 0.7;
  crack.connect(bp);
  bp.connect(crackGain);
  const crackPeak = (heavy ? 0.5 : 0.4) * (crit ? 1.3 : 1);
  crackGain.gain.setValueAtTime(crackPeak, t);
  crackGain.gain.exponentialRampToValueAtTime(0.0001, t + (heavy ? 0.09 : 0.05));
  crack.start(t);
  crack.stop(t + 0.12);
};

/** Play the swing whoosh — a short filtered-noise sweep as the strike leaves. */
export const playWhoosh = (strength: HitStrength): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  const heavy = strength === 'heavy';
  const t = now(c);

  const g = c.createGain();
  g.connect(master);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(heavy ? 500 : 800, t);
  bp.frequency.exponentialRampToValueAtTime(heavy ? 1600 : 2400, t + (heavy ? 0.22 : 0.14));
  src.connect(bp);
  bp.connect(g);
  const peak = heavy ? 0.22 : 0.14;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (heavy ? 0.24 : 0.16));
  src.start(t);
  src.stop(t + 0.3);
};

/** Bright metallic ping for a successful parry. */
export const playParry = (): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  const t = now(c);

  const g = c.createGain();
  g.connect(master);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

  // Two detuned high partials = shimmering metal.
  for (const [hz, detune] of [
    [2100, 0],
    [3150, 7],
  ] as const) {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    osc.detune.value = detune;
    osc.connect(g);
    osc.start(t);
    osc.stop(t + 0.5);
  }
};
