export interface IntroLayer {
  /** Public path to a full-canvas image. Every layer shares the same 16:9 origin. */
  src: string;
  /** Parallax strength: 0 is effectively fixed, 1 is the nearest foreground. */
  depth: number;
  /** Optional compositing mode for light-only atmospheric plates. */
  blend?: 'normal' | 'screen' | 'lighten';
  /** Used only if the bitmap cannot be loaded. */
  fallback?: string;
  /** Authored motion for this layer, independent of pointer input and other layers. */
  motion: {
    delayMs?: number;
    durationMs: number;
    fromX: number;
    toX: number;
    fromY: number;
    toY: number;
    fromScale: number;
    toScale: number;
  };
  /** Piecewise-linear opacity animation for flashes and other timed effects. */
  opacityKeys?: Array<{ atMs: number; opacity: number }>;
}

export interface IntroCaptionCue {
  /** Normalized position in the voice-over, from 0 to 1. */
  start: number;
  /** Normalized position in the voice-over, from 0 to 1. */
  end: number;
  text: string;
}

export interface IntroScene {
  id: string;
  label: string;
  layers: IntroLayer[];
  captions: IntroCaptionCue[];
  /** Used until voice-over metadata is available or when audio cannot load. */
  fallbackDurationMs: number;
  /** A short visual hold after the final spoken word. */
  tailMs: number;
  /** Music-only pre-roll before narration begins. */
  voiceDelayMs: number;
  vo?: string;
  bgm?: string;
  /** BGM level during the dark pre-roll. */
  bgmVolume: number;
  /** BGM level once narration begins. */
  bgmDuckVolume: number;
  sfx?: Array<{
    src: string;
    atMs: number;
    volume: number;
  }>;
  kenBurns: {
    fromScale: number;
    toScale: number;
    fromX: number;
    toX: number;
    fromY: number;
    toY: number;
  };
  glow?: string;
  reveal: {
    holdMs: number;
    fadeMs: number;
  };
}

const INTRO_ROOT = '/intro';

export const INTRO_SCENES: IntroScene[] = [
  {
    id: 'scene-1',
    label: 'The Cradle',
    layers: [
      {
        src: `${INTRO_ROOT}/panel01-bg.webp`,
        depth: 0.04,
        fallback: 'radial-gradient(120% 90% at 50% 34%, #2a2740 0%, #12131f 55%, #05060d 100%)',
        motion: {
          durationMs: 9_000,
          fromX: 0,
          toX: -0.18,
          fromY: 0.04,
          toY: -0.18,
          fromScale: 1.01,
          toScale: 1.018,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-mid.webp`,
        depth: 0.32,
        motion: {
          delayMs: 180,
          durationMs: 8_700,
          fromX: 0.08,
          toX: -0.24,
          fromY: 0.08,
          toY: -0.28,
          fromScale: 1.025,
          toScale: 1.04,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-fg.webp`,
        depth: 0.82,
        motion: {
          delayMs: 360,
          durationMs: 8_500,
          fromX: 0.18,
          toX: -0.22,
          fromY: 0.2,
          toY: -0.28,
          fromScale: 1.06,
          toScale: 1.095,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-atmos.webp`,
        depth: 0.14,
        blend: 'screen',
        motion: {
          delayMs: 700,
          durationMs: 7_200,
          fromX: -0.15,
          toX: 0.4,
          fromY: 0.38,
          toY: -0.62,
          fromScale: 1.025,
          toScale: 1.055,
        },
      },
    ],
    captions: [
      {
        start: 0.04,
        end: 0.54,
        text: 'The world of Aethelgard died a long time ago.',
      },
      {
        start: 0.5,
        end: 0.98,
        text: "We're just the parasites living on the battery fumes.",
      },
    ],
    fallbackDurationMs: 13_250,
    tailMs: 900,
    voiceDelayMs: 2_250,
    vo: `${INTRO_ROOT}/audio/vo-01.mp3`,
    bgm: `${INTRO_ROOT}/audio/scene1-bgm.mp3`,
    bgmVolume: 0.46,
    bgmDuckVolume: 0.24,
    kenBurns: {
      fromScale: 1.02,
      toScale: 1.204,
      fromX: 0,
      toX: 0,
      fromY: 0.008,
      toY: -0.016,
    },
    glow: 'rgba(150, 132, 214, 0.32)',
    reveal: {
      holdMs: 1_600,
      fadeMs: 2_400,
    },
  },
  {
    id: 'scene-2',
    label: 'Terminus Over the Abyss',
    layers: [
      {
        src: `${INTRO_ROOT}/panel02.webp`,
        depth: 0.05,
        fallback: 'linear-gradient(#111a33 0%, #080e1d 45%, #010308 100%)',
        motion: {
          durationMs: 8_500,
          fromX: 0,
          toX: -0.12,
          fromY: 2.8,
          toY: -0.8,
          fromScale: 1.035,
          toScale: 1.11,
        },
      },
      {
        src: `${INTRO_ROOT}/panel02-atmos.webp`,
        depth: 0.2,
        blend: 'screen',
        motion: {
          delayMs: 120,
          durationMs: 8_200,
          fromX: -0.12,
          toX: 0.36,
          fromY: 1.2,
          toY: -1.4,
          fromScale: 1.035,
          toScale: 1.065,
        },
      },
      {
        src: `${INTRO_ROOT}/panel02-lightning.webp`,
        depth: 0.16,
        blend: 'screen',
        motion: {
          durationMs: 8_500,
          fromX: 0.18,
          toX: -0.08,
          fromY: 0.8,
          toY: -0.45,
          fromScale: 1.035,
          toScale: 1.075,
        },
        opacityKeys: [
          { atMs: 0, opacity: 0 },
          { atMs: 2_420, opacity: 0 },
          { atMs: 2_470, opacity: 1 },
          { atMs: 2_590, opacity: 0.12 },
          { atMs: 2_700, opacity: 0.72 },
          { atMs: 2_900, opacity: 0 },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel02-ribs.webp`,
        depth: 1,
        motion: {
          durationMs: 2_900,
          fromX: -0.5,
          toX: 0.35,
          fromY: -9,
          toY: 38,
          fromScale: 1.13,
          toScale: 1.06,
        },
      },
    ],
    captions: [
      {
        start: 0.04,
        end: 0.96,
        text: "We're just the parasites living on the battery fumes.",
      },
    ],
    fallbackDurationMs: 8_700,
    tailMs: 800,
    voiceDelayMs: 420,
    vo: `${INTRO_ROOT}/audio/vo-02.mp3`,
    bgm: `${INTRO_ROOT}/audio/scene1-bgm.mp3`,
    bgmVolume: 0.4,
    bgmDuckVolume: 0.23,
    sfx: [
      {
        src: `${INTRO_ROOT}/audio/scene2-lightning.mp3`,
        atMs: 2_470,
        volume: 0.72,
      },
    ],
    kenBurns: {
      fromScale: 1,
      toScale: 1.045,
      fromX: 0,
      toX: 0,
      fromY: 0.018,
      toY: -0.008,
    },
    glow: 'rgba(117, 103, 184, 0.16)',
    reveal: {
      holdMs: 0,
      fadeMs: 520,
    },
  },
];
