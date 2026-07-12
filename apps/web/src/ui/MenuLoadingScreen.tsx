import { useEffect, useRef, useState } from 'react';

/**
 * The pre-menu loading screen. The main menu's three heavy assets — the key-art backdrop,
 * the looping harp theme, and the rigged hero model — take a beat to fetch and decode, and
 * without this the menu pops in piecemeal (blank backdrop, silent, no hero). We hold this
 * on-brand splash over the menu until everything is ready, then fade it away.
 *
 * `progress` is the caller's raw readiness fraction (0..1). We ease a *displayed* value
 * toward it so the bar always glides — and while not-yet-`ready` we cap the crawl short of
 * full so the final snap to 100% reads as "done", not "stuck". Once `ready`, we drive the
 * bar home, hold a breath, fade, then unmount via `onDismiss`.
 */

const FLAVOR = [
  'Waking the harp in the ruined hall',
  'Dusting off forgotten relics',
  'Rousing the hero',
  'Charting the wasteland',
] as const;

interface Props {
  /** Raw readiness 0..1 (share of critical assets loaded). */
  progress: number;
  /** True once every critical asset is loaded — releases the bar to 100% and fades out. */
  ready: boolean;
  /** Called after the fade-out completes so the parent can unmount us. */
  onDismiss: () => void;
}

export const MenuLoadingScreen = ({ progress, ready, onDismiss }: Props) => {
  const [shown, setShown] = useState(0); // eased bar fill, 0..1
  const [fading, setFading] = useState(false);
  const [flavor] = useState(() => FLAVOR[Math.floor(Math.random() * FLAVOR.length)]!);
  const raf = useRef<number | null>(null);
  const dismissed = useRef(false);

  // Ease the displayed fill toward the target every frame — purely cosmetic. Target trails
  // `progress` but is capped at 0.9 until `ready`, so loaded-but-not-done never sits at a
  // misleading 100%. rAF is paused in a hidden/background tab; that's fine here because the
  // DISMISS logic below runs off timers, not this loop — the bar just catches up on refocus.
  useEffect(() => {
    const tick = () => {
      const target = ready ? 1 : Math.min(0.9, progress);
      setShown((v) => {
        const next = v + (target - v) * 0.12;
        return next > 0.999 ? 1 : next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [progress, ready]);

  // Dismiss as soon as every asset is ready. Driven by `ready` + setTimeout (NOT the eased
  // bar), so a menu opened in a background tab — where rAF is frozen — still fades away and
  // hands control back instead of wedging on the splash forever.
  useEffect(() => {
    if (!ready || dismissed.current) return;
    dismissed.current = true;
    setShown(1); // snap the bar full for the fade in case rAF was paused (hidden tab)
    const fadeTimer = window.setTimeout(() => setFading(true), 220);
    const doneTimer = window.setTimeout(onDismiss, 220 + 620); // + the fade duration below
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, [ready, onDismiss]);

  const pct = Math.round(shown * 100);

  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-black transition-opacity duration-[620ms] ease-out ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
      aria-busy="true"
      role="status"
    >
      {/* Soft teal glow bloom behind the wordmark, matching the menu's key-light hue. */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[60vmin] w-[60vmin] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
        style={{
          background:
            'radial-gradient(circle, rgba(45,212,191,0.35) 0%, rgba(45,212,191,0.08) 45%, transparent 70%)',
        }}
      />

      <div className="relative flex flex-col items-center">
        <div className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.5em] text-teal-300/70">
          Co-op Relic Roguelite
        </div>
        <h1 className="mb-12 text-5xl font-black uppercase tracking-[0.1em] text-white drop-shadow-[0_2px_16px_rgba(45,212,191,0.35)]">
          Relic <span className="text-amber-400">Relay</span>
        </h1>

        {/* Progress bar: a thin track with an amber fill and a moving specular sheen. */}
        <div className="relative h-[3px] w-72 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300"
            style={{ width: `${pct}%`, transition: 'width 90ms linear' }}
          />
          <div
            className="absolute inset-y-0 w-24 -translate-x-full"
            style={{
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)',
              animation: 'menuload-sheen 1.15s ease-in-out infinite',
            }}
          />
        </div>

        <div className="mt-4 flex w-72 items-center justify-between text-[0.6rem] uppercase tracking-[0.3em] text-white/45">
          <span>{flavor}…</span>
          <span className="tabular-nums text-white/60">{pct}%</span>
        </div>
      </div>

      <style>{`
        @keyframes menuload-sheen {
          0% { transform: translateX(0); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
};
