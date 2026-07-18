/**
 * WORLD LIGHTING — the single source of truth for how the world is LIT.
 *
 * This is the lighting twin of `feel/config.ts`: one object, tuned BY FEEL, that every
 * world-rendering surface reads from instead of hardcoding its own magic numbers. Today
 * the sky palette, key/fill/ambient rig, fog, warm lantern tint and the post-grade all
 * live as scattered constants across SkyAndLight / PostFX / atmosphericFog / lanterns /
 * terrain. Pulling them here means:
 *
 *   1. A whole scene re-lights COHERENTLY from one `WorldMood` — sky, lights, fog and the
 *      colour grade always agree, because they come from the same authored preset. This is
 *      what separates the flat, milky look (uniform ambient, no warm/cool contrast, no
 *      grade) from the cinematic one (a directional key, warm accents punching cool base,
 *      deep blacks from the grade).
 *   2. New moods are additive data, not a code change — a storm night, a blood moon or a
 *      dawn is a new entry, and the world obeys it everywhere at once.
 *   3. It's leva-tunable live, exactly like FeelControls: read the mutable object each
 *      frame, tweak → play → repeat.
 *
 * WHY DISCRETE MOODS, NOT A REAL-TIME SUN CYCLE: the art is stylised and hand-graded. A
 * continuously-interpolated day/night cycle averages every mood into mush; authored moods
 * let each one keep its own deliberate warm/cool contrast and grade. Cross-fade BETWEEN two
 * moods (see `blendMoods`) when a transition is wanted, rather than driving a sun angle.
 *
 * COLOUR SPACE: hex strings are sRGB as authored (fed to `new Color(hex)`); the numeric
 * light/fog/grade values are the same units three.js + postprocessing already consume, so a
 * preset can reproduce the current build byte-for-byte (see `deepNight` / `dusk`).
 */

export interface SkyPalette {
  /** Straight-up sky colour. */
  zenith: string;
  /** The broad band between zenith and horizon. */
  upperSky: string;
  /** The colour the sky settles to at the skyline. */
  horizon: string;
  /** The warm/coloured wash pulled in around the sun/moon and into the fog inscatter. */
  sunset: string;
  /** Lit face of the cloud banks. */
  cloudLight: string;
  /** Shadowed underside of the cloud banks. */
  cloudShadow: string;
  /** The sun/moon disc + halo colour. */
  sun: string;
  /** Distance-fog base colour (three's `fog.color`). */
  fog: string;
}

/** A directional light (the key "sun/moon", or the cool fill/bounce). */
export interface DirectionalRig {
  /** World-space direction the light comes FROM (also used to orient the sky disc). */
  position: [number, number, number];
  color: string;
  intensity: number;
}

/** Hemisphere ambient — cheap skylight that fills shadows without flattening the key. */
export interface AmbientRig {
  /** Light coming from above (sky colour). */
  skyColor: string;
  /** Light bounced up from the ground. */
  groundColor: string;
  /** Keep this LOW — high ambient is the #1 cause of the flat, milky look. */
  intensity: number;
}

/** Height fog + directional inscattering (see atmosphericFog.ts). */
export interface FogRig {
  /** three `fogExp2` density. Higher = thicker aerial perspective / shorter draw. */
  density: number;
  /** How fast fog thins with world height (peaks clear faster). */
  heightFalloff: number;
  /** Floor of haze retained high up so far peaks/spires still recede. */
  heightFloor: number;
  /** Tightness of the warm glow around the sun/moon in the fog. */
  inscatterPower: number;
  /** How far fog shifts toward `sunset` looking into the sun/moon (0..1). */
  inscatterStrength: number;
}

/** The post-processing colour grade — where "deep blacks + punch" actually comes from. */
export interface GradeRig {
  /** N8AO contact-shadow radius / strength — seats props in the ground. */
  aoRadius: number;
  aoIntensity: number;
  aoDistanceFalloff: number;
  /** Bloom on true HDR emitters only (threshold > 1 keeps the sky from washing white). */
  bloomIntensity: number;
  bloomThreshold: number;
  bloomSmoothing: number;
  bloomRadius: number;
  /** Global saturation trim (postprocessing HueSaturation, -1..1). */
  saturation: number;
  /** Global brightness/contrast trim — contrast is what carves blacks out of the milk. */
  brightness: number;
  contrast: number;
  /** Vignette that focuses the eye and deepens the frame edges. */
  vignetteOffset: number;
  vignetteDarkness: number;
}

/** Warm practical lights (lanterns, windows, campfires) — the accent that fights the cool key. */
export interface WarmLightRig {
  color: string;
  /** Base point-light intensity before per-light flicker. */
  intensity: number;
  /** Point-light reach. */
  distance: number;
}

/** A complete, art-directed lighting state for a scene. Switching mood re-lights everything. */
export interface WorldMood {
  sky: SkyPalette;
  /** The dominant directional light (golden sun in the hub, cool moon on the expedition). */
  key: DirectionalRig;
  /** A soft opposing fill so the key's shadow side never goes fully black. */
  fill: DirectionalRig;
  ambient: AmbientRig;
  fog: FogRig;
  grade: GradeRig;
  warm: WarmLightRig;
  /** 1 = the sun disc is drawn in the sky; 0 = hidden (expedition uses the moon mesh instead). */
  discStrength: number;
}

// ── PRESETS ────────────────────────────────────────────────────────────────────────────
// `dusk` and `deepNight` reproduce today's hub / expedition look EXACTLY (values lifted from
// SkyAndLight/PostFX/fog/lanterns), so wiring the system in is a no-op refactor. The others
// are new authored moods that demonstrate re-lighting the whole world from one entry.

/** Shared sky palette — hub and expedition currently share this; only disc/grade/fog differ. */
const DUSK_SKY: SkyPalette = {
  zenith: '#202746',
  upperSky: '#3b426c',
  horizon: '#6a5d82',
  sunset: '#80559a',
  cloudLight: '#9493b6',
  cloudShadow: '#343653',
  sun: '#ddd4ff',
  fog: '#3b3957',
};

/** Golden-hour clarity inside the social hub: warm key visible, low fog, gentle grade. */
export const dusk: WorldMood = {
  sky: DUSK_SKY,
  key: { position: [-30, 11, -56], color: '#cecfda', intensity: 3.45 },
  fill: { position: [24, 15, 30], color: '#aaa8ba', intensity: 0.62 },
  ambient: { skyColor: '#adb3c3', groundColor: '#343443', intensity: 1.3 },
  fog: { density: 0.0075, heightFalloff: 0.045, heightFloor: 0.78, inscatterPower: 2.5, inscatterStrength: 0.7 },
  grade: {
    aoRadius: 0.78, aoIntensity: 1.04, aoDistanceFalloff: 1.2,
    bloomIntensity: 0.74, bloomThreshold: 1.02, bloomSmoothing: 0.28, bloomRadius: 0.68,
    saturation: 0.02, brightness: 0.02, contrast: 0.035,
    vignetteOffset: 0.34, vignetteDarkness: 0.28,
  },
  warm: { color: '#ff963b', intensity: 3.6, distance: 10 },
  discStrength: 1,
};

/** The expedition's moonlit night: cool directional key, thicker haze, punchier grade. */
export const deepNight: WorldMood = {
  sky: DUSK_SKY,
  key: { position: [24, 8, -58], color: '#cecfda', intensity: 2.95 },
  fill: { position: [24, 15, 30], color: '#aaa8ba', intensity: 0.52 },
  ambient: { skyColor: '#adb3c3', groundColor: '#343443', intensity: 1.08 },
  fog: { density: 0.0115, heightFalloff: 0.045, heightFloor: 0.78, inscatterPower: 2.5, inscatterStrength: 0.7 },
  grade: {
    aoRadius: 1.05, aoIntensity: 1.12, aoDistanceFalloff: 1,
    bloomIntensity: 0.58, bloomThreshold: 1.02, bloomSmoothing: 0.24, bloomRadius: 0.62,
    saturation: 0.045, brightness: 0.005, contrast: 0.05,
    vignetteOffset: 0.34, vignetteDarkness: 0.32,
  },
  warm: { color: '#ff963b', intensity: 3.6, distance: 10 },
  discStrength: 0,
};

/**
 * NEW MOOD — a low, red-lit blood moon. Colder blacks, a hot amber horizon, brighter warm
 * practicals, and a heavier grade. Demonstrates re-lighting from data alone: sky tint + key
 * colour + fog inscatter + saturation all shift together toward the same authored intent.
 */
export const bloodMoon: WorldMood = {
  sky: {
    zenith: '#1a1230',
    upperSky: '#341f3f',
    horizon: '#7a3346',
    sunset: '#b8483a',
    cloudLight: '#a86b6b',
    cloudShadow: '#2c1a2c',
    sun: '#ffb098',
    fog: '#3a2233',
  },
  key: { position: [24, 6, -58], color: '#e8a48f', intensity: 2.6 },
  fill: { position: [24, 15, 30], color: '#7a5a8a', intensity: 0.44 },
  ambient: { skyColor: '#8f7684', groundColor: '#2c2030', intensity: 0.92 },
  fog: { density: 0.0128, heightFalloff: 0.05, heightFloor: 0.74, inscatterPower: 2.2, inscatterStrength: 0.82 },
  grade: {
    aoRadius: 1.05, aoIntensity: 1.2, aoDistanceFalloff: 1,
    bloomIntensity: 0.64, bloomThreshold: 1.0, bloomSmoothing: 0.22, bloomRadius: 0.66,
    saturation: 0.08, brightness: -0.01, contrast: 0.07,
    vignetteOffset: 0.3, vignetteDarkness: 0.4,
  },
  warm: { color: '#ff7a2e', intensity: 4.4, distance: 11 },
  discStrength: 0,
};

/**
 * NEW MOOD — an overcast storm night. The key light is smothered and cool, fog is heavy and
 * nearly monochrome (weak inscatter), and the grade pulls saturation down and contrast up so
 * the scene reads as a bleak, high-key-suppressed slog where only the warm practicals carry.
 */
export const stormNight: WorldMood = {
  sky: {
    zenith: '#161a26',
    upperSky: '#242a3a',
    horizon: '#3c4152',
    sunset: '#4a5066',
    cloudLight: '#6b7186',
    cloudShadow: '#20242f',
    sun: '#c7ccda',
    fog: '#2b2f3c',
  },
  key: { position: [18, 10, -54], color: '#b6bcca', intensity: 1.9 },
  fill: { position: [24, 15, 30], color: '#8a90a0', intensity: 0.6 },
  ambient: { skyColor: '#9aa0b0', groundColor: '#2a2e38', intensity: 1.24 },
  fog: { density: 0.017, heightFalloff: 0.038, heightFloor: 0.82, inscatterPower: 3.2, inscatterStrength: 0.28 },
  grade: {
    aoRadius: 1.1, aoIntensity: 1.16, aoDistanceFalloff: 0.9,
    bloomIntensity: 0.5, bloomThreshold: 1.05, bloomSmoothing: 0.26, bloomRadius: 0.6,
    saturation: -0.14, brightness: 0.0, contrast: 0.06,
    vignetteOffset: 0.32, vignetteDarkness: 0.36,
  },
  warm: { color: '#ffa24c', intensity: 4.0, distance: 11 },
  discStrength: 0,
};

/**
 * NEW MOOD — a cool-to-warm dawn. Blue zenith, peach horizon, a low warm key just clearing
 * the skyline, light fog and a gentle grade. The clearest, most hopeful preset — the tonal
 * opposite of `stormNight`, reached with the same knobs.
 */
export const dawn: WorldMood = {
  sky: {
    zenith: '#2a3a5c',
    upperSky: '#556684',
    horizon: '#c98f78',
    sunset: '#e0a878',
    cloudLight: '#e8d5c0',
    cloudShadow: '#4a4a63',
    sun: '#fff0dd',
    fog: '#6f6a7a',
  },
  key: { position: [-40, 7, -50], color: '#ffe0b8', intensity: 3.0 },
  fill: { position: [30, 18, 40], color: '#8fa4c8', intensity: 0.7 },
  ambient: { skyColor: '#b9c2d6', groundColor: '#3d3a42', intensity: 1.35 },
  fog: { density: 0.008, heightFalloff: 0.045, heightFloor: 0.78, inscatterPower: 2.2, inscatterStrength: 0.72 },
  grade: {
    aoRadius: 0.85, aoIntensity: 1.0, aoDistanceFalloff: 1.2,
    bloomIntensity: 0.7, bloomThreshold: 1.02, bloomSmoothing: 0.28, bloomRadius: 0.66,
    saturation: 0.03, brightness: 0.02, contrast: 0.03,
    vignetteOffset: 0.36, vignetteDarkness: 0.24,
  },
  warm: { color: '#ffb265', intensity: 2.6, distance: 9 },
  discStrength: 1,
};

/**
 * NEW MOOD — a sickly, toxic fog. Green-lit and heavy, with the warm practicals kept warm on
 * purpose so they punch through the miasma. High fog density + green inscatter carry it.
 */
export const toxicFog: WorldMood = {
  sky: {
    zenith: '#161f18',
    upperSky: '#233026',
    horizon: '#3f5a33',
    sunset: '#7fae3a',
    cloudLight: '#8aa662',
    cloudShadow: '#1c281a',
    sun: '#d6f0a0',
    fog: '#2f3d29',
  },
  key: { position: [20, 9, -54], color: '#b6d47a', intensity: 1.8 },
  fill: { position: [24, 15, 30], color: '#6a8a5a', intensity: 0.5 },
  ambient: { skyColor: '#8fa878', groundColor: '#26301f', intensity: 1.2 },
  fog: { density: 0.02, heightFalloff: 0.035, heightFloor: 0.84, inscatterPower: 2.6, inscatterStrength: 0.55 },
  grade: {
    aoRadius: 1.1, aoIntensity: 1.18, aoDistanceFalloff: 0.9,
    bloomIntensity: 0.52, bloomThreshold: 1.03, bloomSmoothing: 0.24, bloomRadius: 0.6,
    saturation: -0.02, brightness: -0.005, contrast: 0.06,
    vignetteOffset: 0.3, vignetteDarkness: 0.4,
  },
  warm: { color: '#ffb84c', intensity: 4.0, distance: 10 },
  discStrength: 0,
};

/**
 * NEW MOOD — a total eclipse. Near-black sky, a hot corona rim in the inscatter, very low
 * ambient so the world falls into deep shadow, and a heavy high-contrast grade with corona
 * bloom. The darkest preset — proof that "how black are the blacks" is an ambient+grade dial.
 */
export const eclipse: WorldMood = {
  sky: {
    zenith: '#0d0e18',
    upperSky: '#181726',
    horizon: '#2a2036',
    sunset: '#ff7a4a',
    cloudLight: '#4a4258',
    cloudShadow: '#101018',
    sun: '#fff2e0',
    fog: '#1c1a26',
  },
  key: { position: [10, 12, -56], color: '#c0b8d0', intensity: 1.2 },
  fill: { position: [24, 15, 30], color: '#6a6480', intensity: 0.35 },
  ambient: { skyColor: '#6a6784', groundColor: '#1a1822', intensity: 0.7 },
  fog: { density: 0.014, heightFalloff: 0.05, heightFloor: 0.72, inscatterPower: 1.8, inscatterStrength: 0.9 },
  grade: {
    aoRadius: 1.05, aoIntensity: 1.25, aoDistanceFalloff: 1,
    bloomIntensity: 0.8, bloomThreshold: 0.98, bloomSmoothing: 0.2, bloomRadius: 0.7,
    saturation: 0.06, brightness: -0.02, contrast: 0.09,
    vignetteOffset: 0.28, vignetteDarkness: 0.46,
  },
  warm: { color: '#ff7a2e', intensity: 4.6, distance: 11 },
  discStrength: 0,
};

/**
 * NEW MOOD — a warm celebratory gold wash for a victory/clear state. Warmer ambient, brighter
 * bloom and lifted saturation flood the scene with gold; the tonal opposite of `eclipse`.
 */
export const victoryGold: WorldMood = {
  sky: {
    zenith: '#3a3355',
    upperSky: '#6a5a72',
    horizon: '#d9a95e',
    sunset: '#ffcf7a',
    cloudLight: '#ffe6b0',
    cloudShadow: '#4a4258',
    sun: '#fff3d4',
    fog: '#5c5060',
  },
  key: { position: [-28, 12, -54], color: '#ffe1a0', intensity: 3.4 },
  fill: { position: [24, 15, 30], color: '#c8a878', intensity: 0.7 },
  ambient: { skyColor: '#c8bfb0', groundColor: '#403a38', intensity: 1.4 },
  fog: { density: 0.0085, heightFalloff: 0.045, heightFloor: 0.8, inscatterPower: 2.4, inscatterStrength: 0.75 },
  grade: {
    aoRadius: 0.8, aoIntensity: 1.0, aoDistanceFalloff: 1.2,
    bloomIntensity: 0.82, bloomThreshold: 1.0, bloomSmoothing: 0.28, bloomRadius: 0.7,
    saturation: 0.06, brightness: 0.025, contrast: 0.03,
    vignetteOffset: 0.36, vignetteDarkness: 0.22,
  },
  warm: { color: '#ffbe5c', intensity: 3.8, distance: 10 },
  discStrength: 1,
};

export type MoodName =
  | 'dusk'
  | 'deepNight'
  | 'bloodMoon'
  | 'stormNight'
  | 'dawn'
  | 'toxicFog'
  | 'eclipse'
  | 'victoryGold';

export const MOODS: Record<MoodName, WorldMood> = {
  dusk,
  deepNight,
  bloodMoon,
  stormNight,
  dawn,
  toxicFog,
  eclipse,
  victoryGold,
};

/**
 * The active mood, resolved per scene. The `hub` uses `dusk`; the `expedition` uses whatever
 * `expeditionMood` is set to (default `deepNight`) — flip it to preview a storm/blood moon on
 * the whole world at once. Mutable so a leva panel can drive it live.
 */
export const worldLighting = {
  hubMood: 'dusk' as MoodName,
  expeditionMood: 'deepNight' as MoodName,
};

/** Resolve the WorldMood for a scene. */
export const moodForScene = (scene: 'hub' | 'expedition'): WorldMood =>
  MOODS[scene === 'hub' ? worldLighting.hubMood : worldLighting.expeditionMood];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Cross-fade two moods (0 = a, 1 = b) for authored transitions — e.g. easing the expedition
 * from `deepNight` into `bloodMoon` as a wave escalates. Colours are left to the consumer to
 * interpolate in Color space; this blends the scalar rig so the fade stays coherent.
 */
export const blendMoodScalars = (a: WorldMood, b: WorldMood, t: number) => ({
  keyIntensity: lerp(a.key.intensity, b.key.intensity, t),
  fillIntensity: lerp(a.fill.intensity, b.fill.intensity, t),
  ambientIntensity: lerp(a.ambient.intensity, b.ambient.intensity, t),
  fogDensity: lerp(a.fog.density, b.fog.density, t),
  contrast: lerp(a.grade.contrast, b.grade.contrast, t),
  saturation: lerp(a.grade.saturation, b.grade.saturation, t),
  discStrength: lerp(a.discStrength, b.discStrength, t),
});
