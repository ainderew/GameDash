import { netClient } from '@/net/client';
import { useUIStore } from '@/ui/store';

/**
 * DOM overlay HUD (outside the WebGL canvas). Reads throttled ECS state from the
 * Zustand store — never subscribes to the 60Hz simulation directly.
 *
 * Juice: the health bar drains in two stages (instant green + a delayed red "chip"), and
 * the combo counter re-pops on every landed hit via a remount-keyed CSS animation.
 */
export const CombatHUD = () => {
  const health = useUIStore((s) => s.health);
  const maxHealth = useUIStore((s) => s.maxHealth);
  const materials = useUIStore((s) => s.materials);
  const wave = useUIStore((s) => s.wave);
  const monstersAlive = useUIStore((s) => s.monstersAlive);
  const huntFailed = useUIStore((s) => s.huntFailed);
  const comboCount = useUIStore((s) => s.comboCount);
  const comboBumpId = useUIStore((s) => s.comboBumpId);
  const pct = Math.max(0, Math.min(100, (health / maxHealth) * 100));

  // Return to the hub after a failed hunt. Networked: ask the server to flip the whole party
  // (it resets expedition state + teleports everyone). Solo: switch scene + reset locally —
  // the same button now works in both modes (Phase 6 Task 2 fixes the solo gap).
  const returnToHub = () => {
    const store = useUIStore.getState();
    store.setHuntFailed(false);
    if (store.session) {
      netClient.returnToHub();
    } else {
      store.reset();
      store.setScene('hub');
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <style>{`
        @keyframes combo-pop {
          0%   { transform: translateX(-50%) scale(1.6); }
          55%  { transform: translateX(-50%) scale(0.9); }
          100% { transform: translateX(-50%) scale(1); }
        }
        .combo-pop { animation: combo-pop 220ms cubic-bezier(0.2, 1.4, 0.4, 1); }
      `}</style>

      {/* Health bar with a delayed chip drain (red trails behind the green). */}
      <div className="absolute left-4 top-4 w-64">
        <div className="mb-1 flex justify-between text-xs font-semibold uppercase tracking-wider text-teal-200/80">
          <span>HP</span>
          <span className="tabular-nums">{Math.ceil(health)}</span>
        </div>
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10">
          {/* Chip layer: lags behind so damage momentarily exposes a red bar. */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-rose-500/80 transition-[width] delay-200 duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
          {/* Live layer: snaps to the current value. */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-teal-400 to-emerald-400 transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Combo counter — pops on every landed hit. */}
      {comboCount >= 2 && (
        <div
          key={comboBumpId}
          className="combo-pop absolute left-1/2 top-24 -translate-x-1/2 text-center"
        >
          <div className="text-5xl font-black text-amber-300 [text-shadow:_0_2px_8px_rgb(0_0_0_/_60%)]">
            {comboCount}
            <span className="text-3xl text-amber-200">×</span>
          </div>
          <div className="text-[0.65rem] uppercase tracking-[0.3em] text-amber-200/70">combo</div>
        </div>
      )}

      {/* Wave + materials */}
      <div className="absolute right-4 top-16 flex flex-col items-end gap-1 text-sm">
        <div className="rounded-md bg-black/40 px-3 py-1 ring-1 ring-white/10">
          Wave <span className="font-bold text-amber-300">{wave}</span>
          <span className="ml-2 text-white/50">· {monstersAlive} alive</span>
        </div>
        <div className="rounded-md bg-black/40 px-3 py-1 ring-1 ring-white/10">
          <span className="text-emerald-300">◆</span> Materials{' '}
          <span className="font-bold tabular-nums">{materials}</span>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-black/40 px-4 py-2 text-center text-xs text-white/70 ring-1 ring-white/10">
        <span className="font-semibold text-white/90">WASD</span> walk ·{' '}
        <span className="font-semibold text-white/90">Shift</span> run ·{' '}
        <span className="font-semibold text-white/90">Space</span> jump ·{' '}
        <span className="font-semibold text-white/90">Ctrl</span> dodge ·{' '}
        <span className="font-semibold text-white/90">L-click / J</span> melee ·{' '}
        <span className="font-semibold text-white/90">R-click / K</span> shoot ·{' '}
        <span className="font-semibold text-white/90">F</span> parry ·{' '}
        <span className="font-semibold text-white/90">E</span> pass relic (hold: aim) ·{' '}
        <span className="font-semibold text-white/90">G</span> drop relic ·{' '}
        <span className="font-semibold text-white/90">Tab</span> swap weapon ·{' '}
        <span className="font-semibold text-white/90">Mouse</span> camera ·{' '}
        <span className="font-semibold text-white/90">Wheel</span> zoom ·{' '}
        <span className="font-semibold text-white/90">Esc</span> free cursor
      </div>

      {/* Hunt failed */}
      {huntFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60">
          <h1 className="text-4xl font-black text-red-400">HUNT FAILED</h1>
          <p className="text-white/60">The party was downed. Regroup at the Haven and try again.</p>
          <button
            className="pointer-events-auto rounded-md bg-amber-400/90 px-6 py-2 font-semibold uppercase tracking-[0.2em] text-black ring-1 ring-amber-200/40 transition-colors hover:bg-amber-300"
            onClick={returnToHub}
          >
            Return to Hub
          </button>
        </div>
      )}
    </div>
  );
};
