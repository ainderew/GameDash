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
  /** Fixed scenes may hand off while a longer narration file continues playing. */
  durationMode?: 'voice' | 'fixed';
  /** A short visual hold after the final spoken word. */
  tailMs: number;
  /** Optional faster fade at a scene boundary. */
  fadeOutMs?: number;
  /** Music-only pre-roll before narration begins. */
  voiceDelayMs: number;
  vo?: string;
  /** Keep the previous scene's active voice element instead of restarting narration. */
  continueVoice?: boolean;
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
          durationMs: 11_500,
          fromX: 0.15,
          toX: -0.55,
          fromY: 0.15,
          toY: -0.5,
          fromScale: 1.005,
          toScale: 1.03,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-mid.webp`,
        depth: 0.32,
        motion: {
          delayMs: 140,
          durationMs: 10_200,
          fromX: 0.5,
          toX: -1.1,
          fromY: 0.45,
          toY: -0.9,
          fromScale: 1.025,
          toScale: 1.095,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-fg.webp`,
        depth: 0.82,
        motion: {
          delayMs: 280,
          durationMs: 8_600,
          fromX: 1.15,
          toX: -1.85,
          fromY: 0.95,
          toY: -1.55,
          fromScale: 1.065,
          toScale: 1.215,
        },
      },
      {
        src: `${INTRO_ROOT}/panel01-atmos.webp`,
        depth: 0.14,
        blend: 'screen',
        motion: {
          delayMs: 420,
          durationMs: 7_400,
          fromX: -1.35,
          toX: 1.9,
          fromY: 1.8,
          toY: -2.35,
          fromScale: 1.035,
          toScale: 1.11,
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
    bgmVolume: 0.6,
    bgmDuckVolume: 0.31,
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
    fallbackDurationMs: 4_600,
    durationMode: 'fixed',
    tailMs: 0,
    voiceDelayMs: 420,
    vo: `${INTRO_ROOT}/audio/vo-02.mp3`,
    bgm: `${INTRO_ROOT}/audio/scene1-bgm.mp3`,
    bgmVolume: 0.52,
    bgmDuckVolume: 0.3,
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
  {
    id: 'scene-3',
    label: 'Bones and Hearts',
    layers: [
      {
        src: `${INTRO_ROOT}/panel03.webp`,
        depth: 0.05,
        fallback: 'linear-gradient(100deg, #171719 0%, #0c111a 48%, #090817 100%)',
        motion: {
          durationMs: 4_550,
          fromX: 0.35,
          toX: -0.55,
          fromY: 0.12,
          toY: -0.18,
          fromScale: 1.01,
          toScale: 1.04,
        },
      },
    ],
    captions: [
      {
        start: 0.03,
        end: 0.62,
        text: 'When the Titans tore each other apart, they left us their bones... and their hearts.',
      },
      {
        start: 0.6,
        end: 0.96,
        text: 'We call them Relics.',
      },
    ],
    fallbackDurationMs: 4_550,
    durationMode: 'fixed',
    tailMs: 0,
    fadeOutMs: 220,
    voiceDelayMs: 0,
    continueVoice: true,
    bgm: `${INTRO_ROOT}/audio/scene1-bgm.mp3`,
    bgmVolume: 0.52,
    bgmDuckVolume: 0.3,
    kenBurns: {
      fromScale: 1.075,
      toScale: 1.145,
      fromX: 0.035,
      toX: -0.035,
      fromY: 0.008,
      toY: -0.006,
    },
    glow: 'rgba(100, 78, 190, 0.14)',
    reveal: {
      holdMs: 0,
      fadeMs: 480,
    },
  },
  {
    id: 'scene-4',
    label: 'The Vault Relic',
    layers: [
      {
        src: `${INTRO_ROOT}/panel04-bg.webp`,
        depth: 0.04,
        fallback: 'radial-gradient(circle at 50% 46%, #18223a 0%, #090d16 42%, #020306 100%)',
        motion: {
          durationMs: 12_500,
          fromX: 0.08,
          toX: -0.18,
          fromY: 0.1,
          toY: -0.22,
          fromScale: 1.01,
          toScale: 1.055,
        },
      },
      {
        src: `${INTRO_ROOT}/panel04-subject.webp`,
        depth: 0.68,
        motion: {
          delayMs: 140,
          durationMs: 10_800,
          fromX: 0.75,
          toX: -0.48,
          fromY: 0.55,
          toY: -0.46,
          fromScale: 1.035,
          toScale: 1.14,
        },
      },
      {
        src: `${INTRO_ROOT}/panel04-fx.webp`,
        depth: 0.38,
        motion: {
          durationMs: 9_600,
          fromX: -0.12,
          toX: 0.2,
          fromY: 0.25,
          toY: -0.38,
          fromScale: 1.01,
          toScale: 1.12,
        },
        opacityKeys: [
          { atMs: 0, opacity: 0.72 },
          { atMs: 1_600, opacity: 1 },
          { atMs: 3_400, opacity: 0.8 },
          { atMs: 5_300, opacity: 1 },
          { atMs: 7_200, opacity: 0.84 },
          { atMs: 9_600, opacity: 1 },
        ],
      },
    ],
    captions: [
      {
        start: 0.03,
        end: 0.48,
        text: 'Infinite energy. One Relic can keep the neon lights of Terminus burning for a decade.',
      },
      {
        start: 0.46,
        end: 0.8,
        text: 'The mega-corps will pay anything for them.',
      },
      {
        start: 0.78,
        end: 0.97,
        text: "But there's a catch.",
      },
    ],
    fallbackDurationMs: 12_500,
    tailMs: 900,
    voiceDelayMs: 320,
    vo: `${INTRO_ROOT}/audio/vo-04.mp3`,
    bgm: `${INTRO_ROOT}/audio/scene1-bgm.mp3`,
    bgmVolume: 0.52,
    bgmDuckVolume: 0.3,
    kenBurns: {
      fromScale: 1.015,
      toScale: 1.12,
      fromX: 0,
      toX: 0,
      fromY: 0.008,
      toY: -0.01,
    },
    glow: 'rgba(95, 121, 220, 0.22)',
    reveal: {
      holdMs: 0,
      fadeMs: 280,
    },
  },
];
