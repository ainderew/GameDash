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
    /** Canvas-relative pivot used to keep an isolated foreground object anchored. */
    originX?: number;
    originY?: number;
  };
  /** Short authored accents layered over the continuous drift. */
  motionEvents?: Array<{
    atMs: number;
    durationMs: number;
    x?: number;
    y?: number;
    scale?: number;
    rotateDeg?: number;
    brightness?: number;
    saturate?: number;
  }>;
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
  cameraEvents?: Array<{
    atMs: number;
    durationMs: number;
    zoom: number;
    shake: number;
    originX: number;
    originY: number;
  }>;
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
    fadeOutMs: 240,
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
  {
    id: 'scene-5',
    label: 'Corruption Takes Hold',
    layers: [
      {
        src: `${INTRO_ROOT}/panel05-bg.webp`,
        depth: 0.04,
        fallback: 'radial-gradient(circle at 70% 58%, #32215a 0%, #121426 38%, #030407 100%)',
        motion: {
          durationMs: 9_000,
          fromX: 0.45,
          toX: -1.1,
          fromY: 0.2,
          toY: -0.55,
          fromScale: 1.015,
          toScale: 1.07,
        },
      },
      {
        src: `${INTRO_ROOT}/panel05-subject.webp`,
        depth: 0.46,
        motion: {
          delayMs: 90,
          durationMs: 8_350,
          fromX: 0.9,
          toX: -1.65,
          fromY: 0.45,
          toY: -0.95,
          fromScale: 1.025,
          toScale: 1.13,
          originX: 52,
          originY: 51,
        },
        motionEvents: [
          {
            atMs: 1_180,
            durationMs: 920,
            x: -0.35,
            y: -0.25,
            scale: 0.018,
            rotateDeg: -0.25,
            brightness: 1.08,
            saturate: 1.08,
          },
          {
            atMs: 4_240,
            durationMs: 1_050,
            x: -0.28,
            y: 0.2,
            scale: 0.022,
            rotateDeg: 0.22,
            brightness: 1.12,
            saturate: 1.1,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel05-relic.webp`,
        depth: 0.92,
        motion: {
          delayMs: 280,
          durationMs: 7_150,
          fromX: 0.55,
          toX: -1.95,
          fromY: 0.65,
          toY: -1.35,
          fromScale: 1.035,
          toScale: 1.19,
          originX: 78,
          originY: 72,
        },
        motionEvents: [
          {
            atMs: 1_180,
            durationMs: 920,
            x: 0.55,
            y: -0.35,
            scale: 0.075,
            rotateDeg: 0.6,
            brightness: 1.55,
            saturate: 1.35,
          },
          {
            atMs: 4_240,
            durationMs: 1_050,
            x: 0.22,
            y: -0.18,
            scale: 0.045,
            rotateDeg: -0.35,
            brightness: 1.35,
            saturate: 1.22,
          },
        ],
        opacityKeys: [
          { atMs: 0, opacity: 0.84 },
          { atMs: 1_100, opacity: 1 },
          { atMs: 1_520, opacity: 0.88 },
          { atMs: 2_050, opacity: 1 },
          { atMs: 9_000, opacity: 1 },
        ],
      },
    ],
    captions: [
      {
        start: 0.03,
        end: 0.34,
        text: "They aren't just batteries.",
      },
      {
        start: 0.31,
        end: 0.67,
        text: "They're alive. They're angry.",
      },
      {
        start: 0.64,
        end: 0.97,
        text: 'And they want a body.',
      },
    ],
    fallbackDurationMs: 9_000,
    durationMode: 'fixed',
    tailMs: 0,
    voiceDelayMs: 180,
    vo: `${INTRO_ROOT}/audio/vo-05.mp3`,
    bgm: `${INTRO_ROOT}/audio/intro-bgm-remain.mp3`,
    bgmVolume: 0.56,
    bgmDuckVolume: 0.31,
    kenBurns: {
      fromScale: 1.015,
      toScale: 1.095,
      fromX: 0.006,
      toX: -0.008,
      fromY: 0.006,
      toY: -0.008,
    },
    glow: 'rgba(113, 73, 230, 0.2)',
    reveal: {
      holdMs: 0,
      fadeMs: 240,
    },
    cameraEvents: [
      {
        atMs: 1_350,
        durationMs: 680,
        zoom: 0.095,
        shake: 0.24,
        originX: 73,
        originY: 68,
      },
      {
        atMs: 4_350,
        durationMs: 820,
        zoom: 0.135,
        shake: 0.38,
        originX: 29,
        originY: 24,
      },
    ],
  },
  {
    id: 'scene-6',
    label: 'Hollowed Goliath',
    layers: [
      {
        src: `${INTRO_ROOT}/panel06.webp`,
        depth: 0.12,
        fallback: 'radial-gradient(circle at 45% 38%, #34206b 0%, #11182d 42%, #03050b 100%)',
        motion: {
          durationMs: 8_000,
          fromX: 0.45,
          toX: -0.55,
          fromY: 2.8,
          toY: -3.2,
          fromScale: 1.025,
          toScale: 1.145,
          originX: 50,
          originY: 54,
        },
        motionEvents: [
          {
            atMs: 6_250,
            durationMs: 920,
            x: -0.22,
            y: -0.28,
            scale: 0.035,
            rotateDeg: -0.18,
            brightness: 1.72,
            saturate: 1.38,
          },
        ],
      },
    ],
    captions: [
      {
        start: 0.05,
        end: 0.95,
        text: 'The Corruption rewrites your DNA and hollows you out.',
      },
    ],
    fallbackDurationMs: 8_000,
    durationMode: 'fixed',
    tailMs: 0,
    voiceDelayMs: 0,
    bgmVolume: 0,
    bgmDuckVolume: 0,
    kenBurns: {
      fromScale: 1.01,
      toScale: 1.075,
      fromX: 0.004,
      toX: -0.006,
      fromY: 0.018,
      toY: -0.022,
    },
    glow: 'rgba(112, 75, 236, 0.24)',
    reveal: {
      holdMs: 0,
      fadeMs: 220,
    },
    cameraEvents: [
      {
        atMs: 6_250,
        durationMs: 920,
        zoom: 0.09,
        shake: 0.22,
        originX: 38,
        originY: 24,
      },
    ],
  },
  {
    id: 'scene-7',
    label: "Couriers' Arrival",
    layers: [
      {
        src: `${INTRO_ROOT}/panel07-bg-v2.webp`,
        depth: 0.05,
        fallback: 'linear-gradient(180deg, #0b2740 0%, #07111d 48%, #050608 100%)',
        motion: {
          durationMs: 8_000,
          fromX: 0.15,
          toX: -0.4,
          fromY: 0.1,
          toY: -0.3,
          fromScale: 1.015,
          toScale: 1.07,
        },
      },
      {
        src: `${INTRO_ROOT}/panel07-pod.webp`,
        depth: 0.28,
        motion: {
          durationMs: 7_800,
          fromX: 0.15,
          toX: -0.55,
          fromY: -0.05,
          toY: -0.5,
          fromScale: 1.025,
          toScale: 1.105,
          originX: 50,
          originY: 48,
        },
        motionEvents: [
          {
            atMs: 120,
            durationMs: 620,
            y: 0.8,
            scale: 0.025,
            rotateDeg: 0.22,
            brightness: 1.18,
            saturate: 1.08,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel07-druid.webp`,
        depth: 0.45,
        motion: {
          delayMs: 240,
          durationMs: 7_600,
          fromX: 0.1,
          toX: -0.6,
          fromY: 0.2,
          toY: -0.65,
          fromScale: 1.02,
          toScale: 1.13,
          originX: 67,
          originY: 46,
        },
        motionEvents: [
          {
            atMs: 150,
            durationMs: 650,
            y: 0.38,
            scale: 0.016,
            rotateDeg: 0.12,
            brightness: 1.1,
            saturate: 1.06,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel07-trickster.webp`,
        depth: 0.68,
        motion: {
          delayMs: 160,
          durationMs: 7_250,
          fromX: 1,
          toX: -2.2,
          fromY: 0.5,
          toY: -1.2,
          fromScale: 1.04,
          toScale: 1.22,
          originX: 25,
          originY: 57,
        },
        motionEvents: [
          {
            atMs: 140,
            durationMs: 680,
            x: -0.35,
            y: 0.62,
            scale: 0.025,
            rotateDeg: -0.24,
            brightness: 1.13,
            saturate: 1.1,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel07-engineer.webp`,
        depth: 0.73,
        motion: {
          delayMs: 190,
          durationMs: 7_150,
          fromX: -0.6,
          toX: 1.8,
          fromY: 0.4,
          toY: -1,
          fromScale: 1.04,
          toScale: 1.21,
          originX: 84,
          originY: 58,
        },
        motionEvents: [
          {
            atMs: 160,
            durationMs: 680,
            x: 0.3,
            y: 0.58,
            scale: 0.024,
            rotateDeg: 0.22,
            brightness: 1.14,
            saturate: 1.08,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel07-warrior.webp`,
        depth: 0.86,
        motion: {
          delayMs: 120,
          durationMs: 6_900,
          fromX: 0.2,
          toX: -0.7,
          fromY: 0.8,
          toY: -1.4,
          fromScale: 1.05,
          toScale: 1.28,
          originX: 48,
          originY: 64,
        },
        motionEvents: [
          {
            atMs: 120,
            durationMs: 700,
            y: 0.72,
            scale: 0.035,
            rotateDeg: -0.12,
            brightness: 1.16,
            saturate: 1.1,
          },
        ],
      },
      {
        src: `${INTRO_ROOT}/panel07-fg.webp`,
        depth: 0.96,
        motion: {
          durationMs: 6_900,
          fromX: 0.8,
          toX: -1.8,
          fromY: 1,
          toY: -1.4,
          fromScale: 1.06,
          toScale: 1.28,
          originX: 50,
          originY: 72,
        },
        motionEvents: [
          {
            atMs: 100,
            durationMs: 700,
            x: -0.2,
            y: 1.05,
            scale: 0.045,
            rotateDeg: 0.2,
            brightness: 1.2,
            saturate: 1.12,
          },
        ],
        opacityKeys: [
          { atMs: 0, opacity: 0.84 },
          { atMs: 280, opacity: 0.96 },
          { atMs: 900, opacity: 0.84 },
          { atMs: 8_000, opacity: 0.84 },
        ],
      },
    ],
    captions: [
      {
        start: 0.08,
        end: 0.88,
        text: "That's where you come in. Couriers.",
      },
    ],
    fallbackDurationMs: 8_000,
    durationMode: 'fixed',
    tailMs: 0,
    voiceDelayMs: 0,
    bgmVolume: 0,
    bgmDuckVolume: 0,
    kenBurns: {
      fromScale: 1,
      toScale: 1.025,
      fromX: 0.002,
      toX: -0.004,
      fromY: 0.004,
      toY: -0.008,
    },
    glow: 'rgba(91, 145, 214, 0.13)',
    reveal: {
      holdMs: 0,
      fadeMs: 180,
    },
    cameraEvents: [
      {
        atMs: 150,
        durationMs: 680,
        zoom: 0.035,
        shake: 0.65,
        originX: 50,
        originY: 62,
      },
    ],
  },
  {
    id: 'scene-8',
    label: 'Vanguard Unleashed',
    layers: [
      {
        src: `${INTRO_ROOT}/panel08.webp`,
        depth: 0.14,
        fallback: 'radial-gradient(circle at 64% 48%, #9b4c16 0%, #1a1b2c 35%, #05070d 100%)',
        motion: {
          durationMs: 3_400,
          fromX: 1.8,
          toX: -2.2,
          fromY: 1.1,
          toY: -0.8,
          fromScale: 1.02,
          toScale: 1.14,
          originX: 57,
          originY: 52,
        },
        motionEvents: [
          {
            atMs: 2_550,
            durationMs: 900,
            x: -0.4,
            y: -0.22,
            scale: 0.05,
            rotateDeg: 0.3,
            brightness: 1.65,
            saturate: 1.35,
          },
        ],
      },
    ],
    captions: [
      {
        start: 0.05,
        end: 0.95,
        text: 'You want to survive the Cradle? You share the burden.',
      },
    ],
    fallbackDurationMs: 8_000,
    durationMode: 'fixed',
    tailMs: 0,
    voiceDelayMs: 0,
    bgmVolume: 0,
    bgmDuckVolume: 0,
    kenBurns: {
      fromScale: 1.015,
      toScale: 1.015,
      fromX: 0,
      toX: 0,
      fromY: 0,
      toY: 0,
    },
    glow: 'rgba(246, 148, 54, 0.2)',
    reveal: {
      holdMs: 0,
      fadeMs: 160,
    },
    cameraEvents: [
      {
        atMs: 2_650,
        durationMs: 760,
        zoom: 0.07,
        shake: 0.5,
        originX: 64,
        originY: 48,
      },
    ],
  },
];
