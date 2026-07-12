import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef, useState } from 'react';
import type { Group } from 'three';
import { localPlayers, relics } from '@/game/ecs/world';
import { relicNet } from '@/net/relicNet';
import { useUIStore } from '@/ui/store';
import { corruptionBand, corruptionProgress, type CorruptionBand } from './relicCorruption';

const SEGMENTS = 5;
const RUNES = [
  '/ui/corruption/runes/awakening.webp',
  '/ui/corruption/runes/binding.webp',
  '/ui/corruption/runes/fracture.webp',
  '/ui/corruption/runes/hunger.webp',
  '/ui/corruption/runes/eruption.webp',
] as const;

interface MeterView {
  progress: number;
  band: CorruptionBand;
}

/**
 * World-anchored carrier HUD. It is rendered in DOM for crisp readability and floats above the
 * carrier as a shallow card arc, keeping both the character silhouette and Relic unobstructed.
 */
export const CorruptionMeter = () => {
  const anchor = useRef<Group>(null);
  const holding = useRef(false);
  const lastDisplayedPercent = useRef(-1);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<MeterView>({ progress: 0, band: 'stable' });

  useFrame(() => {
    const store = useUIStore.getState();
    const session = store.session;
    const local = localPlayers.first;
    const relic = relics.first;
    const networked = session !== undefined;
    const isCarrier = networked
      ? store.relicCarrier === session.playerId
      : relic?.relic.phase === 'carried' && relic.relic.carrier === local;

    if (!isCarrier || !local?.transform || store.scene !== 'expedition') {
      if (holding.current) {
        holding.current = false;
        lastDisplayedPercent.current = -1;
        setVisible(false);
        setView({ progress: 0, band: 'stable' });
      }
      return;
    }

    if (!holding.current) {
      holding.current = true;
      setVisible(true);
    }

    const g = anchor.current;
    if (g) {
      const [x, y, z] = local.transform.position;
      g.position.set(x, y + 2.8, z);
    }

    const corruption = networked ? relicNet.state.corruption : (relic?.relic.corruption ?? 0);
    const progress = corruptionProgress(corruption);
    const percent = Math.round(progress * 100);
    if (percent !== lastDisplayedPercent.current) {
      lastDisplayedPercent.current = percent;
      setView({ progress, band: corruptionBand(progress) });
    }
  });

  const filled = Math.min(1, view.progress / 0.9) * SEGMENTS;
  const terminalCharge = Math.max(0, Math.min(1, (view.progress - 0.9) / 0.1));
  const terminalShaking = terminalCharge > 0;
  const terminalViolent = terminalCharge >= 0.7;
  const label = view.band === 'critical' ? 'PASS NOW' : view.band === 'warning' ? 'PASS SOON' : '';

  return (
    <group ref={anchor}>
      {visible && (
        <Html center zIndexRange={[30, 10]} style={{ pointerEvents: 'none' }}>
          <div
            className={`corruption-meter corruption-meter--${view.band}`}
            role="meter"
            aria-label={`Relic corruption ${Math.round(view.progress * 100)} percent`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(view.progress * 100)}
          >
            <div className="corruption-meter__arc" aria-hidden="true">
              {RUNES.map((runeSrc, i) => {
                const amount = Math.max(0, Math.min(1, filled - i));
                return (
                  <div className="corruption-meter__tile" data-segment={i} key={runeSrc}>
                    <div
                      className="corruption-meter__tile-fill"
                      style={{ transform: `scaleY(${amount})` }}
                    />
                    <div
                      className="corruption-meter__cracks"
                      style={{ opacity: amount * (i === 3 ? 0.38 : i === 4 ? 0.78 : 0) }}
                    />
                    <img className="corruption-meter__rune" src={runeSrc} alt="" />
                  </div>
                );
              })}
              <div
                className={`corruption-meter__terminal${terminalShaking ? ' corruption-meter__terminal--shaking' : ''}${terminalViolent ? ' corruption-meter__terminal--violent' : ''}`}
              >
                <div className="corruption-meter__terminal-card">
                  <img
                    className="corruption-meter__terminal-base"
                    src="/ui/corruption/runes/terminal-core.webp"
                    alt=""
                  />
                  <img
                    className="corruption-meter__terminal-fill"
                    src="/ui/corruption/runes/terminal-core.webp"
                    alt=""
                    style={{ clipPath: `inset(${(1 - terminalCharge) * 100}% 0 0 0)` }}
                  />
                </div>
                <span
                  className="corruption-meter__terminal-flare"
                  style={{ opacity: terminalCharge * terminalCharge }}
                />
              </div>
            </div>
            {label && <div className="corruption-meter__label">{label}</div>}
          </div>
        </Html>
      )}
    </group>
  );
};
