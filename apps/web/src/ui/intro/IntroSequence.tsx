import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beginIntroAudio, getIntroAudio, stopIntroAudio } from '@/ui/intro/introAudio';
import { INTRO_SCENES, type IntroLayer, type IntroScene } from '@/ui/intro/introScenes';
import { useUIStore } from '@/ui/store';

const FADE_MS = 850;
const CAPTION_FADE_MS = 320;
const HOLD_TO_SKIP_MS = 750;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (value: number) => value * value * (3 - 2 * value);

const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
};

const usePreloadedLayers = (layers: IntroLayer[]) => {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setFailed(new Set());

    Promise.all(
      layers.map(
        (layer) =>
          new Promise<void>((resolve) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => {
              if (!cancelled) setFailed((current) => new Set(current).add(layer.src));
              resolve();
            };
            image.src = layer.src;
          }),
      ),
    ).then(() => {
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [layers]);

  return { ready, failed };
};

const MoteField = ({ reducedMotion }: { reducedMotion: boolean }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (reducedMotion) return;
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const palette = ['#8fb6ff', '#b79bff', '#79e0ff', '#cbb6ff'];
    type Mote = { x: number; y: number; radius: number; speed: number; phase: number; color: string };
    let motes: Mote[] = [];
    let frame = 0;

    const resize = () => {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      const count = Math.min(48, Math.round((canvas.clientWidth * canvas.clientHeight) / 34_000));
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: (0.6 + Math.random() * 1.6) * dpr,
        speed: (5 + Math.random() * 12) * dpr,
        phase: Math.random() * Math.PI * 2,
        color: palette[Math.floor(Math.random() * palette.length)]!,
      }));
    };

    resize();
    window.addEventListener('resize', resize);
    let previous = performance.now();

    const draw = (now: number) => {
      const delta = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'lighter';

      for (const mote of motes) {
        mote.y -= mote.speed * delta;
        mote.phase += delta * 0.7;
        if (mote.y < -12) mote.y = canvas.height + 12;
        const x = mote.x + Math.sin(mote.phase) * 8 * dpr;
        const gradient = context.createRadialGradient(x, mote.y, 0, x, mote.y, mote.radius * 4);
        gradient.addColorStop(0, mote.color);
        gradient.addColorStop(1, 'transparent');
        context.globalAlpha = 0.22 + Math.sin(mote.phase * 2) * 0.08;
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, mote.y, mote.radius * 4, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [reducedMotion]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
};

interface SceneViewProps {
  scene: IntroScene;
  durationMs: number;
  failedLayers: Set<string>;
  startedAt: number | null;
  reducedMotion: boolean;
  onDone: () => void;
}

const SceneView = ({ scene, durationMs, failedLayers, startedAt, reducedMotion, onDone }: SceneViewProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (startedAt === null) return;
    let frame = 0;
    let lastCaption = '';

    const animate = (now: number) => {
      const elapsed = now - startedAt;
      const progress = clamp01(elapsed / durationMs);
      const spokenDurationMs = Math.max(1, durationMs - scene.tailMs - scene.voiceDelayMs);
      const captionProgress = clamp01((elapsed - scene.voiceDelayMs) / spokenDurationMs);
      const eased = smoothstep(progress);
      const fadeOut = clamp01((durationMs - elapsed) / (scene.fadeOutMs ?? FADE_MS));

      if (rootRef.current) rootRef.current.style.opacity = String(fadeOut);

      const movementScale = reducedMotion ? 0.25 : 1;
      const kenBurns = scene.kenBurns;
      let scale = lerp(kenBurns.fromScale, kenBurns.toScale, eased * movementScale);
      let x = lerp(kenBurns.fromX, kenBurns.toX, eased * movementScale) * 100;
      let y = lerp(kenBurns.fromY, kenBurns.toY, eased * movementScale) * 100;
      let originX = 50;
      let originY = 50;
      for (const event of scene.cameraEvents ?? []) {
        const eventProgress = (elapsed - event.atMs) / event.durationMs;
        if (eventProgress < 0 || eventProgress > 1) continue;
        const envelope = Math.sin(eventProgress * Math.PI);
        scale += event.zoom * envelope * movementScale;
        x += Math.sin(elapsed * 0.085) * event.shake * envelope * movementScale;
        y += Math.cos(elapsed * 0.11) * event.shake * 0.65 * envelope * movementScale;
        originX = event.originX;
        originY = event.originY;
      }
      if (stageRef.current) {
        stageRef.current.style.transformOrigin = `${originX}% ${originY}%`;
        stageRef.current.style.transform = `translate3d(${x}%, ${y}%, 0) scale(${scale})`;
      }

      scene.layers.forEach((layer, index) => {
        const element = layerRefs.current[index];
        if (!element) return;
        const motion = layer.motion;
        const layerElapsed = Math.max(0, elapsed - (motion.delayMs ?? 0));
        const layerProgress = smoothstep(clamp01(layerElapsed / motion.durationMs));
        const amount = reducedMotion ? layerProgress * 0.25 : layerProgress;
        const px = lerp(motion.fromX, motion.toX, amount);
        const py = lerp(motion.fromY, motion.toY, amount);
        let eventX = 0;
        let eventY = 0;
        let layerScale = lerp(motion.fromScale, motion.toScale, amount);
        let rotateDeg = 0;
        let brightness = 1;
        let saturate = 1;
        for (const event of layer.motionEvents ?? []) {
          const eventProgress = (elapsed - event.atMs) / event.durationMs;
          if (eventProgress < 0 || eventProgress > 1) continue;
          const envelope = Math.sin(eventProgress * Math.PI) * movementScale;
          eventX += (event.x ?? 0) * envelope;
          eventY += (event.y ?? 0) * envelope;
          layerScale += (event.scale ?? 0) * envelope;
          rotateDeg += (event.rotateDeg ?? 0) * envelope;
          brightness += ((event.brightness ?? 1) - 1) * envelope;
          saturate += ((event.saturate ?? 1) - 1) * envelope;
        }
        element.style.transformOrigin = `${motion.originX ?? 50}% ${motion.originY ?? 50}%`;
        element.style.transform = `translate3d(${px + eventX}%, ${py + eventY}%, 0) scale(${layerScale}) rotate(${rotateDeg}deg)`;
        element.style.filter = `brightness(${brightness}) saturate(${saturate})`;
        if (layer.opacityKeys) {
          const nextIndex = layer.opacityKeys.findIndex((key) => key.atMs > elapsed);
          const previous = layer.opacityKeys[Math.max(0, nextIndex === -1 ? layer.opacityKeys.length - 1 : nextIndex - 1)]!;
          const next = nextIndex === -1 ? previous : layer.opacityKeys[nextIndex]!;
          const keyProgress = next.atMs === previous.atMs
            ? 0
            : clamp01((elapsed - previous.atMs) / (next.atMs - previous.atMs));
          element.style.opacity = String(lerp(previous.opacity, next.opacity, keyProgress));
        }
      });

      if (revealRef.current) {
        const revealProgress = smoothstep(clamp01((elapsed - scene.reveal.holdMs) / scene.reveal.fadeMs));
        revealRef.current.style.opacity = String(1 - revealProgress);
      }

      const cue = scene.captions.find(
        (item) => captionProgress >= item.start && captionProgress < item.end,
      );
      const caption = cue?.text ?? '';
      if (captionRef.current) {
        if (caption !== lastCaption) {
          captionRef.current.textContent = caption;
          lastCaption = caption;
        }
        const cueIn = cue
          ? clamp01(((captionProgress - cue.start) * spokenDurationMs) / CAPTION_FADE_MS)
          : 0;
        const cueOut = cue
          ? clamp01(((cue.end - captionProgress) * spokenDurationMs) / CAPTION_FADE_MS)
          : 0;
        captionRef.current.style.opacity = String(Math.min(cueIn, cueOut, fadeOut));
        captionRef.current.style.transform = `translateY(${lerp(10, 0, smoothstep(cueIn))}px)`;
      }

      if (elapsed >= durationMs) {
        onDone();
        return;
      }
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, onDone, reducedMotion, scene, startedAt]);

  return (
    <section ref={rootRef} aria-label={scene.label} className="absolute inset-0 opacity-0">
      <div ref={stageRef} className="absolute inset-0 will-change-transform">
        {scene.layers.map((layer, index) => {
          const failed = failedLayers.has(layer.src);
          return (
            <div
              key={layer.src}
              ref={(element) => {
                layerRefs.current[index] = element;
              }}
              aria-hidden
              className="absolute inset-0 will-change-transform"
              style={{
                background: failed ? layer.fallback : undefined,
                mixBlendMode: layer.blend ?? 'normal',
              }}
            >
              {!failed && (
                <img
                  src={layer.src}
                  alt=""
                  draggable={false}
                  className="h-full w-full select-none object-cover"
                />
              )}
            </div>
          );
        })}
        {scene.glow && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(60% 42% at 50% 44%, ${scene.glow} 0%, transparent 70%)`,
              mixBlendMode: 'screen',
            }}
          />
        )}
      </div>

      <MoteField reducedMotion={reducedMotion} />

      <div
        ref={revealRef}
        aria-hidden
        data-intro-reveal
        className="pointer-events-none absolute inset-0 bg-black"
      />

      <div className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center px-6 sm:px-10">
        <p
          ref={captionRef}
          aria-live="polite"
          className="max-w-4xl text-balance text-center text-xl font-medium leading-snug text-white opacity-0 [text-shadow:0_2px_18px_rgba(0,0,0,0.95)] sm:text-2xl lg:text-3xl"
        />
      </div>
    </section>
  );
};

export const IntroSequence = () => {
  const finishIntro = useUIStore((state) => state.finishIntro);
  const [index, setIndex] = useState(0);
  const [clock, setClock] = useState<{ sceneId: string; startedAt: number } | null>(null);
  const [durationMs, setDurationMs] = useState(INTRO_SCENES[0]!.fallbackDurationMs);
  const [audioReady, setAudioReady] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdFrame = useRef(0);
  const musicRefs = useRef<HTMLAudioElement[]>([]);
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const sfxRef = useRef<HTMLAudioElement[]>([]);
  const audioStartedAt = useRef<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const scene = INTRO_SCENES[index]!;
  const sceneStartedAt = clock?.sceneId === scene.id ? clock.startedAt : null;
  const { ready: imagesReady, failed: failedLayers } = usePreloadedLayers(scene.layers);
  const progress = useMemo(() => (index + 1) / INTRO_SCENES.length, [index]);

  useEffect(() => {
    setClock(null);
    setDurationMs(scene.fallbackDurationMs);
    setAudioReady(false);
    setAudioBlocked(false);
  }, [scene]);

  const stopAudio = useCallback(() => {
    stopIntroAudio();
    voiceRef.current = null;
    musicRefs.current = [];
    sfxRef.current = [];
    audioStartedAt.current = null;
  }, []);

  const completeIntro = useCallback(() => {
    stopAudio();
    finishIntro();
  }, [finishIntro, stopAudio]);

  const advance = useCallback(() => {
    setIndex((current) => {
      if (current + 1 < INTRO_SCENES.length) return current + 1;
      stopAudio();
      finishIntro();
      return current;
    });
  }, [finishIntro, stopAudio]);

  const connectAudioSession = useCallback(
    (forceNew = false) => {
      if (forceNew) {
        stopIntroAudio();
        setClock(null);
        setAudioReady(false);
      }
      const session = forceNew
        ? beginIntroAudio(scene, mutedRef.current)
        : getIntroAudio(scene.id) ?? beginIntroAudio(scene, mutedRef.current);
      voiceRef.current = session.voice ?? null;
      musicRefs.current = session.music;
      sfxRef.current = session.sfx ?? [];
      audioStartedAt.current = session.startedAt;

      void session.started.then((started) => {
        if (!started) audioStartedAt.current = performance.now();
        // Audio failure must never trap the player on a black screen. The cinematic
        // continues on its fallback clock and offers a non-blocking retry.
        setAudioReady(true);
        setAudioBlocked(!started);
      });
      void session.voiceStarted.then((started) => {
        if (!started) setAudioBlocked(true);
      });
    },
    [scene],
  );

  useEffect(() => {
    connectAudioSession(false);
  }, [connectAudioSession]);

  useEffect(() => {
    if (!imagesReady || !audioReady || sceneStartedAt !== null) return;
    setClock({ sceneId: scene.id, startedAt: audioStartedAt.current ?? performance.now() });
  }, [audioReady, imagesReady, scene.id, sceneStartedAt]);

  useEffect(() => {
    mutedRef.current = muted;
    const voice = voiceRef.current;
    if (voice) voice.muted = muted;
    for (const music of musicRefs.current) music.muted = muted;
    for (const effect of sfxRef.current) effect.muted = muted;
  }, [muted]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') completeIntro();
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [completeIntro]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  const beginSkip = () => {
    cancelAnimationFrame(holdFrame.current);
    const start = performance.now();
    const update = (now: number) => {
      const next = clamp01((now - start) / HOLD_TO_SKIP_MS);
      setHoldProgress(next);
      if (next >= 1) {
        completeIntro();
        return;
      }
      holdFrame.current = requestAnimationFrame(update);
    };
    holdFrame.current = requestAnimationFrame(update);
  };

  const cancelSkip = () => {
    cancelAnimationFrame(holdFrame.current);
    setHoldProgress(0);
  };

  return (
    <main className="absolute inset-0 overflow-hidden bg-black text-white">
      <SceneView
        key={scene.id}
        scene={scene}
        durationMs={durationMs}
        failedLayers={failedLayers}
        startedAt={sceneStartedAt}
        reducedMotion={reducedMotion}
        onDone={advance}
      />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 100% at 50% 45%, transparent 50%, rgba(0,0,0,0.65) 100%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.045] mix-blend-overlay"
        style={{ backgroundImage: GRAIN_URL, backgroundRepeat: 'repeat' }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[7vh] bg-black" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[7vh] bg-black" />

      {sceneStartedAt === null && !audioBlocked && (
        <div className="absolute inset-0 grid place-items-center bg-black">
          <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.32em] text-white/55">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-300" />
            Preparing transmission
          </div>
        </div>
      )}

      {audioBlocked && (
        <button
          type="button"
          onClick={() => connectAudioSession(true)}
          className="absolute right-6 top-[9vh] rounded-sm border border-white/25 bg-black/55 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/70 backdrop-blur transition hover:border-white/60 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-300 sm:right-8"
        >
          Enable sound
        </button>
      )}

      {INTRO_SCENES.length > 1 && (
        <div className="absolute bottom-[3vh] left-1/2 h-0.5 w-32 -translate-x-1/2 overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full origin-left bg-white/70 transition-transform"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setMuted((value) => !value)}
        className="absolute bottom-[2.4vh] left-6 rounded px-2 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300 sm:left-8"
        aria-label={muted ? 'Unmute cinematic' : 'Mute cinematic'}
      >
        {muted ? 'Sound off' : 'Sound on'}
      </button>

      <button
        type="button"
        className="absolute bottom-[2.4vh] right-6 flex select-none items-center gap-3 rounded px-2 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-white/60 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300 sm:right-8"
        onPointerDown={beginSkip}
        onPointerUp={cancelSkip}
        onPointerCancel={cancelSkip}
        onPointerLeave={cancelSkip}
        onKeyDown={(event) => {
          if ((event.code === 'Enter' || event.code === 'Space') && !event.repeat) beginSkip();
        }}
        onKeyUp={(event) => {
          if (event.code === 'Enter' || event.code === 'Space') cancelSkip();
        }}
        aria-label="Hold to skip cinematic"
      >
        <span>Hold to skip</span>
        <span className="relative grid h-7 w-7 place-items-center" aria-hidden>
          <svg viewBox="0 0 36 36" className="h-7 w-7 -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 15}
              strokeDashoffset={2 * Math.PI * 15 * (1 - holdProgress)}
            />
          </svg>
          <span className="absolute text-[9px]">SKIP</span>
        </span>
      </button>
    </main>
  );
};
