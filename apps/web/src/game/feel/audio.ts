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

// The sword swing is a real recording (replacing the old procedural noise-sweep whoosh):
// mono, 24 kHz, loudness-normalized to -18 LUFS / -1.5 dBTP so it sits under a landed hit.
// Fetched/decoded once; each swing detunes it (see playWhoosh) so repeats never sound canned.
const SWORD_SWING_URL = '/audio/sword-swing.mp3';
let swordSwingBuffer: AudioBuffer | null = null;
let swordSwingLoad: Promise<void> | null = null;

// The Relic throw/launch is a real recording (replacing the reused sword whoosh that used to
// play on a pass): mono, 24 kHz, loudness-normalized to -18 LUFS / -1.5 dBTP. Fetched/decoded
// once; each throw detunes it (see playRelicThrow) so repeated passes never sound canned.
const RELIC_THROW_URL = '/audio/relic-throw.mp3';
let relicThrowBuffer: AudioBuffer | null = null;
let relicThrowLoad: Promise<void> | null = null;

// AMBIENT WORLD BED — recorded ambiences played PERIODICALLY (not looped) so the world feels
// alive: a distant swell every ~50–110s (scheduling lives in ambientScheduler.ts), each one a
// RANDOM pick from the pool below, then detuned / panned / low-passed a little so it seems to
// drift in from somewhere new instead of reading as the same clip on a timer. Routed through the
// same master bus as the combat SFX, so the Settings volume + mute apply, at a low bed level that
// sits under gameplay.
//
// `gain` is a PER-CLIP loudness trim: the source files are NOT loudness-matched (the monster cry
// is recorded ~13 dB hotter (RMS) than the horror drone), so a single flat level would make one
// swell blast while the other whispers. Each trim normalizes the clip toward the same perceived
// level — measure a new file's RMS and set its gain relative to the drone (1.0) before adding it.
const AMBIENT_POOL = [
  { url: '/audio/ambient-horror.mp3', gain: 1.0 }, // soft drone, RMS ~-27 dB — the reference
  { url: '/audio/ambient-monster-cry.mp3', gain: 0.22 }, // ~13 dB hotter → trim to match the drone
] as const;
let ambientBuffers: readonly AudioBuffer[] = [];
let ambientLoad: Promise<void> | null = null;
// One swell at a time: gaps dwarf the clip length, but a slow decode or a re-fire must never
// stack two ambient beds on top of each other (that reads as a bug, not atmosphere).
let ambientPlaying = false;
let lastAmbientIndex = -1;

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

/** Fetch/decode the sword-swing sample once. Failure is safely retriable. */
const loadSwordSwing = (c: Ctx): void => {
  if (swordSwingBuffer || swordSwingLoad) return;
  swordSwingLoad = (async () => {
    const response = await fetch(SWORD_SWING_URL);
    if (!response.ok) throw new Error(`Unable to load sword swing sample: ${SWORD_SWING_URL}`);
    swordSwingBuffer = await c.decodeAudioData(await response.arrayBuffer());
  })().catch(() => {
    // A missing/undecodable swing must never break attacking.
    swordSwingLoad = null;
  });
};

/** Fetch/decode the Relic-throw sample once. Failure is safely retriable. */
const loadRelicThrow = (c: Ctx): void => {
  if (relicThrowBuffer || relicThrowLoad) return;
  relicThrowLoad = (async () => {
    const response = await fetch(RELIC_THROW_URL);
    if (!response.ok) throw new Error(`Unable to load relic throw sample: ${RELIC_THROW_URL}`);
    relicThrowBuffer = await c.decodeAudioData(await response.arrayBuffer());
  })().catch(() => {
    // A missing/undecodable throw must never break passing the Relic.
    relicThrowLoad = null;
  });
};

/** Fetch/decode the ambient pool once. Failure is safely retriable. */
const loadAmbient = (c: Ctx): void => {
  if (ambientBuffers.length > 0 || ambientLoad) return;
  ambientLoad = Promise.all(
    AMBIENT_POOL.map(async ({ url }) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to load ambient sample: ${url}`);
      return c.decodeAudioData(await response.arrayBuffer());
    }),
  )
    .then((buffers) => {
      ambientBuffers = buffers;
    })
    .catch(() => {
      // A missing/undecodable bed must never break gameplay — just stay silent and retry later.
      ambientLoad = null;
    });
};

/**
 * Resume the audio context — call from a user-gesture handler (mousedown/keydown).
 * No-op until the browser allows it. Also warms the sample caches so the first
 * footstep/swing/pickup/ambient swell doesn't miss while its buffer is still decoding.
 */
export const resumeAudio = (): void => {
  const c = engine();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  loadFootsteps(c);
  loadRelicPickup(c);
  loadSwordSwing(c);
  loadRelicThrow(c);
  loadAmbient(c);
};

/**
 * Push the current audio settings onto the LIVE master bus so a volume or mute change is heard
 * immediately — even while a sound is mid-flight. Matters most for the ambient bed: a swell can
 * run ~16s, so without this a slider nudge (or a mute) wouldn't take effect until the next swell,
 * up to a minute later. Mute (enabled=false) drops the whole bus to 0. No-op before the engine is
 * built (nothing is audible yet anyway); the per-sound `master.gain` writes then take over.
 */
export const syncAudioSettings = (): void => {
  if (!master) return;
  master.gain.value = feel.audio.enabled ? feel.audio.masterVolume : 0;
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

/**
 * Random pitch spread applied to the Relic throw each launch, in semitones (±this much). Same
 * anti-"copy-pasted sample" trick as the pickup — a bidirectional spread here (not up-only like
 * the sword) because passes fire seconds apart, not in a back-to-back combo, so a symmetric
 * ±3 just reads as natural throw-to-throw variety rather than a rising flurry.
 */
const RELIC_THROW_PITCH_SEMITONES = 3;

/**
 * The Relic throw/launch whoosh. Plays the recorded sample, detuned every throw so a string of
 * passes never sounds like the same clip on repeat. Fired on every RelicPassLaunched regardless
 * of who threw. Silently no-ops until the sample has decoded.
 */
export const playRelicThrow = (): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  loadRelicThrow(c);
  const buffer = relicThrowBuffer;
  if (!buffer) return;

  master.gain.value = feel.audio.masterVolume;
  const t = now(c);
  const source = c.createBufferSource();
  const gain = c.createGain();
  source.buffer = buffer;
  // ±N semitones of detune → playbackRate = 2^(semitones/12). Continuous, not quantized.
  const semitones = (Math.random() * 2 - 1) * RELIC_THROW_PITCH_SEMITONES;
  source.playbackRate.value = Math.pow(2, semitones / 12);
  gain.gain.value = 0.5;
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

/**
 * Random pitch applied to the sword swing, in semitones ABOVE the recorded pitch. One-sided
 * and up-only by design: the raw sample is the FLOOR (the original pitch, the heaviest/slowest
 * stroke) and each swing can ride up to +this much for a faster, whippier cut — never duller
 * than the source, since we only ever speed it up. Dramatic (up to a fifth) so a combo reads
 * as clearly distinct strokes instead of one looped clip.
 */
const SWORD_SWING_PITCH_SEMITONES_UP = 7;

/**
 * Play the sword swing as the strike leaves. A real recorded whoosh, pitched UP a random
 * amount every swing (baseline = the original recording) so a combo never sounds like the
 * same clip on repeat. Heavy swings stay nearer the (lower) baseline and hit a touch louder
 * to read as more weight. Silently no-ops until the sample has decoded.
 */
export const playWhoosh = (strength: HitStrength): void => {
  if (!feel.audio.enabled) return;
  const c = engine();
  if (!c || !master) return;
  loadSwordSwing(c);
  const buffer = swordSwingBuffer;
  if (!buffer) return;
  const heavy = strength === 'heavy';

  master.gain.value = feel.audio.masterVolume;
  const t = now(c);
  const source = c.createBufferSource();
  const gain = c.createGain();
  source.buffer = buffer;
  // Up-only: 0 = the original recorded pitch (floor), random amount ABOVE it, never below.
  // Heavy uses a smaller upward range so it stays nearer the heavier baseline.
  // playbackRate = 2^(semitones/12) — continuous, not quantized.
  const maxUp = SWORD_SWING_PITCH_SEMITONES_UP * (heavy ? 0.55 : 1);
  const semitones = Math.random() * maxUp;
  source.playbackRate.value = Math.pow(2, semitones / 12);
  gain.gain.value = heavy ? 0.55 : 0.4;
  source.connect(gain);
  gain.connect(master);
  source.start(t);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
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

/** Bed level for one ambient swell, before the master-volume slider scales it. */
const AMBIENT_LEVEL = 0.06;
/** Slow swell envelope (seconds) so the bed breathes in/out and never pops like an SFX. */
const AMBIENT_FADE_IN = 1.6;
const AMBIENT_FADE_OUT = 2.6;
/** Per-occurrence detune spread (±semitones). Subtle — the drone stays the same "place". */
const AMBIENT_PITCH_SEMITONES = 1.5;

/**
 * Play ONE ambient swell — the periodic world bed. Each play is varied so repeats don't read as
 * the same clip on a loop: a small random detune, a soft L/R pan drift, and a jittered low-pass
 * so some swells feel more distant than others. A slow gain envelope fades it in and back out.
 * Returns false (so the scheduler retries next cycle) while the context is still locked or the
 * buffer hasn't decoded; no-ops when audio is disabled or a swell is already sounding.
 */
export const playAmbient = (): boolean => {
  if (!feel.audio.enabled) return false;
  const c = engine();
  if (!c || !master) return false;
  // WebAudio unlocks on the first gesture; scheduling into a still-suspended context would queue
  // the swell to blare late all at once, so skip and let the scheduler try again next gap.
  if (c.state !== 'running') return false;
  loadAmbient(c);
  if (ambientBuffers.length === 0 || ambientPlaying) return false;
  // Pick a random clip, avoiding an immediate repeat so the pool never fires the same swell
  // twice in a row (with two clips this just alternates when a repeat is rolled).
  let index = Math.floor(Math.random() * ambientBuffers.length);
  if (ambientBuffers.length > 1 && index === lastAmbientIndex) {
    index = (index + 1) % ambientBuffers.length;
  }
  lastAmbientIndex = index;
  const buffer = ambientBuffers[index];
  const clip = AMBIENT_POOL[index];
  if (!buffer || !clip) return false;

  master.gain.value = feel.audio.masterVolume;
  const t = now(c);
  const source = c.createBufferSource();
  const gain = c.createGain();
  const pan = c.createStereoPanner();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400 + Math.random() * 2600; // 1.4–4 kHz: some swells read as more distant

  source.buffer = buffer;
  const semitones = (Math.random() * 2 - 1) * AMBIENT_PITCH_SEMITONES;
  source.playbackRate.value = Math.pow(2, semitones / 12);
  pan.pan.value = (Math.random() * 2 - 1) * 0.7; // drift off-center, never hard-panned

  // Bed level × the clip's loudness trim (see AMBIENT_POOL) × a small random swell-to-swell wobble.
  const peak = AMBIENT_LEVEL * clip.gain * (0.8 + Math.random() * 0.3);
  const dur = buffer.duration / source.playbackRate.value;
  const fadeIn = Math.min(AMBIENT_FADE_IN, dur * 0.4);
  const fadeOut = Math.min(AMBIENT_FADE_OUT, dur * 0.4);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + fadeIn);
  gain.gain.setValueAtTime(peak, t + Math.max(fadeIn, dur - fadeOut));
  gain.gain.linearRampToValueAtTime(0, t + dur);

  source.connect(lp);
  lp.connect(gain);
  gain.connect(pan);
  pan.connect(master);
  ambientPlaying = true;
  source.start(t);
  source.stop(t + dur + 0.05);
  source.onended = () => {
    source.disconnect();
    lp.disconnect();
    gain.disconnect();
    pan.disconnect();
    ambientPlaying = false;
  };
  return true;
};
