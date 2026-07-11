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

const FOOTSTEP_URLS = [
  '/audio/footsteps/step-1.wav',
  '/audio/footsteps/step-2.wav',
  '/audio/footsteps/step-3.wav',
  '/audio/footsteps/step-4.wav',
  '/audio/footsteps/step-5.wav',
] as const;
let footstepBuffers: readonly AudioBuffer[] = [];
let footstepLoad: Promise<void> | null = null;
let nextFootstepVariation = 0;

// The Relic-pickup reward stinger is a real recording (unlike the procedural combat
// sounds): a rising magical swell, loudness-normalized to -16 LUFS / -1.5 dBTP so it
// sits consistently against the synth SFX. Fetched/decoded once, same as footsteps.
const RELIC_PICKUP_URL = '/audio/relic-pickup.wav';
let relicPickupBuffer: AudioBuffer | null = null;
let relicPickupLoad: Promise<void> | null = null;

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

/** Fetch/decode the five user-supplied variations once. Failure is safely retriable. */
const loadFootsteps = (c: Ctx): void => {
  if (footstepBuffers.length > 0 || footstepLoad) return;
  footstepLoad = Promise.all(
    FOOTSTEP_URLS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to load footstep sample: ${url}`);
      return c.decodeAudioData(await response.arrayBuffer());
    }),
  )
    .then((buffers) => {
      footstepBuffers = buffers;
    })
    .catch(() => {
      // Audio must never interfere with movement if an asset is missing or decoding fails.
      footstepLoad = null;
    });
};

/** Fetch/decode the Relic-pickup sample once. Failure is safely retriable. */
const loadRelicPickup = (c: Ctx): void => {
  if (relicPickupBuffer || relicPickupLoad) return;
  relicPickupLoad = (async () => {
    const response = await fetch(RELIC_PICKUP_URL);
    if (!response.ok) throw new Error(`Unable to load relic pickup sample: ${RELIC_PICKUP_URL}`);
    relicPickupBuffer = await c.decodeAudioData(await response.arrayBuffer());
  })().catch(() => {
    // A missing/undecodable stinger must never break the pickup itself.
    relicPickupLoad = null;
  });
};

/**
 * Resume the audio context — call from a user-gesture handler (mousedown/keydown).
 * No-op until the browser allows it. Also warms the sample caches so the first
 * footstep/pickup doesn't miss while its buffer is still decoding.
 */
export const resumeAudio = (): void => {
  const c = engine();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  loadFootsteps(c);
  loadRelicPickup(c);
};

/**
 * Play the next supplied footstep variation. The movement layer provides the cadence; this
 * only shapes the short transient, small pitch variation, and run/walk weight. Returns false
 * while samples are still loading so callers can retry the first step instead of dropping it.
 */
export const playFootstep = (running: boolean): boolean => {
  if (!feel.audio.enabled) return false;
  const c = engine();
  if (!c || !master) return false;
  loadFootsteps(c);
  const buffer = footstepBuffers[nextFootstepVariation % footstepBuffers.length];
  if (!buffer) return false;
  nextFootstepVariation += 1;

  master.gain.value = feel.audio.masterVolume;
  const t = now(c);
  const source = c.createBufferSource();
  const gain = c.createGain();
  source.buffer = buffer;
  source.playbackRate.value = (running ? 1.08 : 0.94) + (Math.random() - 0.5) * 0.08;
  source.connect(gain);
  gain.connect(master);
  const tail = running ? 0.3 : 0.4;
  const peak = running ? 0.23 : 0.17;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
  source.start(t);
  source.stop(t + tail);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
  return true;
};

/**
 * Random pitch spread applied to the pickup each play, in semitones (±this much). The
 * classic "sample doesn't sound copy-pasted" trick: a fixed one-shot repeated verbatim
 * reads as canned, so we detune it every time. ±3 semitones (~±18% speed) is clearly
 * audible without turning chipmunky/sludgy — a subtler ±1.5 was inaudible in play because
 * pickups fire seconds apart, so there's no back-to-back A/B reference for the ear.
 */
const RELIC_PICKUP_PITCH_SEMITONES = 20;

/**
 * The Relic-pickup reward stinger. Plays the pre-normalized sample through a gain node with
 * a small random pitch shift so a repeated pickup never sounds identical. The 0.9 gain
 * (× 0.8 master) lands it at a prominent-but-unclipped ~0.6 peak, on par with a heavy hit
 * so claiming the Relic feels like an event. Silently no-ops if the buffer isn't ready.
 */
export const playRelicPickup = (): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  loadRelicPickup(c);
  const buffer = relicPickupBuffer;
  if (!buffer) return;

  master.gain.value = feel.audio.masterVolume;
  const t = now(c);
  const source = c.createBufferSource();
  const gain = c.createGain();
  source.buffer = buffer;
  // ±N semitones of detune → playbackRate = 2^(semitones/12). Continuous, not quantized.
  const semitones = (Math.random() * 2 - 1) * RELIC_PICKUP_PITCH_SEMITONES;
  source.playbackRate.value = Math.pow(2, semitones / 12);
  gain.gain.value = 0.9;
  source.connect(gain);
  gain.connect(master);
  source.start(t);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
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

/**
 * Soft directional chime — the receiver's "incoming pass" warning. Panned toward the
 * thrower's side of the screen (see stereoPanFor). Deliberately gentle: it fires every
 * few seconds during normal relay play.
 */
export const playPassChime = (pan: number): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  const t = now(c);

  const panner = c.createStereoPanner();
  panner.pan.value = Math.min(1, Math.max(-1, pan));
  panner.connect(master);

  const g = c.createGain();
  g.connect(panner);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);

  // A soft fifth (two sine partials) reads as "friendly incoming", not an alarm.
  for (const [hz, at] of [
    [880, 0],
    [1320, 0.05],
  ] as const) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    osc.connect(g);
    osc.start(t + at);
    osc.stop(t + 0.35);
  }
};

/** Low, short error tone — a confirmed pass failed (receiver downed or escaped). */
export const playPassFail = (): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  const t = now(c);

  const g = c.createGain();
  g.connect(master);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.22); // downward = "denied"
  osc.connect(g);
  osc.start(t);
  osc.stop(t + 0.3);
};
