import { useEffect, useRef } from 'react';
import { relics, localPlayers } from '@/game/ecs/world';
import { relicNet } from '@/net/relicNet';
import { useUIStore } from '@/ui/store';
import { RELIC_CORRUPTION_TUNING } from '@shared/balance';

const smoothstep = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** Local-only warning: the carrier's peripheral vision darkens from Volatile onward. */
export const CorruptionVignette = () => {
  const overlay = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let smoothed = 0;
    const tick = (time: number) => {
      const store = useUIStore.getState();
      const session = store.session;
      const local = localPlayers.first;
      const relic = relics.first;
      const networked = session !== undefined;
      const carrier = networked
        ? store.relicCarrier === session.playerId
        : relic?.relic.phase === 'carried' && relic.relic.carrier === local;
      const corruption = networked ? relicNet.state.corruption : (relic?.relic.corruption ?? 0);
      const progress = corruption / RELIC_CORRUPTION_TUNING.max;
      const target =
        carrier && progress >= 0.7 ? 0.2 + smoothstep((progress - 0.7) / 0.3) * 0.8 : 0;
      smoothed += (target - smoothed) * 0.08;

      const element = overlay.current;
      if (element) {
        const pulse = 0.88 + Math.sin(time * 0.0067) * 0.07 + Math.sin(time * 0.0143) * 0.04;
        element.style.opacity = String(smoothed * pulse);
        element.style.transform = `scale(${1 + smoothed * Math.sin(time * 0.009) * 0.012})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={overlay}
      aria-hidden="true"
      className="pointer-events-none fixed inset-[-2%] z-20 opacity-0"
      style={{
        background:
          'radial-gradient(circle at center, transparent 35%, rgba(32, 0, 52, 0.12) 55%, rgba(25, 0, 43, 0.72) 100%)',
        boxShadow: 'inset 0 0 11rem 2.5rem rgba(80, 0, 125, 0.34)',
        transition: 'opacity 120ms linear',
        willChange: 'opacity, transform',
      }}
    />
  );
};
