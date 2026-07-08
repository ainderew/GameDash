import { useUIStore } from '@/ui/store';

/**
 * DOM overlay HUD (outside the WebGL canvas). Reads throttled ECS state from the
 * Zustand store — never subscribes to the 60Hz simulation directly.
 */
export const CombatHUD = () => {
  const health = useUIStore((s) => s.health);
  const maxHealth = useUIStore((s) => s.maxHealth);
  const materials = useUIStore((s) => s.materials);
  const wave = useUIStore((s) => s.wave);
  const monstersAlive = useUIStore((s) => s.monstersAlive);
  const huntFailed = useUIStore((s) => s.huntFailed);
  const pct = Math.max(0, Math.min(100, (health / maxHealth) * 100));

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Health bar */}
      <div className="absolute left-4 top-4 w-64">
        <div className="mb-1 flex justify-between text-xs font-semibold uppercase tracking-wider text-teal-200/80">
          <span>HP</span>
          <span className="tabular-nums">{Math.ceil(health)}</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-teal-400 to-emerald-400 transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

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
        <span className="font-semibold text-white/90">WASD</span> move ·{' '}
        <span className="font-semibold text-white/90">Space</span> jump ·{' '}
        <span className="font-semibold text-white/90">Shift</span> dodge ·{' '}
        <span className="font-semibold text-white/90">L-click / J</span> melee ·{' '}
        <span className="font-semibold text-white/90">R-click / K</span> shoot
      </div>

      {/* Hunt failed */}
      {huntFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60">
          <h1 className="text-4xl font-black text-red-400">HUNT FAILED</h1>
          <p className="text-white/60">You were downed. (Hunt lifecycle lands in Phase 5.)</p>
          <button
            className="pointer-events-auto rounded-md bg-white/10 px-5 py-2 ring-1 ring-white/20 hover:bg-white/20"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
};
