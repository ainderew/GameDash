import { HUB_STATIONS } from '@/game/world/hubLayout';
import { PLAYER_CHARACTERS } from '@/game/entities/characters';
import { useUIStore } from '@/ui/store';

export const HubHUD = () => {
  const stationId = useUIStore((s) => s.hubStation);
  const character = useUIStore((s) => s.playerCharacter);
  const countdown = useUIStore((s) => s.zoneCountdown);
  const station = HUB_STATIONS.find((entry) => entry.id === stationId);

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Shared expedition countdown banner — any member can press E at the gate to cancel. */}
      {countdown !== null && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-2xl border border-amber-300/40 bg-black/70 px-8 py-4 text-center shadow-2xl backdrop-blur-md">
          <div className="text-[0.65rem] font-semibold uppercase tracking-[0.32em] text-amber-200/70">
            Expedition begins in
          </div>
          <div className="mt-1 text-6xl font-black tabular-nums text-amber-300 [text-shadow:_0_2px_12px_rgba(251,191,36,0.5)]">
            {countdown}
          </div>
          <div className="mt-1 text-xs text-white/55">
            Press <span className="font-semibold text-amber-200">E</span> at the gate to cancel
          </div>
        </div>
      )}

      <div className="absolute left-5 top-5 rounded-xl border border-amber-100/15 bg-[#17120d]/70 px-5 py-3 shadow-xl backdrop-blur-md">
        <div className="text-[0.65rem] font-semibold uppercase tracking-[0.32em] text-amber-200/65">Safe Haven</div>
        <div className="mt-0.5 text-xl font-black tracking-wide text-amber-50">HEARTWOOD HAVEN</div>
        <div className="mt-1 text-xs text-white/55">Prepare together. Choose a route. Bring the Relic home.</div>
      </div>

      <div className="absolute right-5 top-5 rounded-lg border border-white/10 bg-black/45 px-4 py-2 text-right shadow-lg backdrop-blur-sm">
        <div className="text-[0.6rem] uppercase tracking-[0.25em] text-white/45">Active adventurer</div>
        <div className="text-sm font-bold text-teal-200">{PLAYER_CHARACTERS[character].label}</div>
      </div>

      {station && (
        <div className="absolute bottom-20 left-1/2 w-[min(92vw,28rem)] -translate-x-1/2 rounded-xl border border-amber-100/20 bg-[#17120d]/85 px-5 py-3 text-center shadow-2xl backdrop-blur-md">
          <div className="text-sm font-black uppercase tracking-[0.18em] text-amber-100">{station.title}</div>
          <div className="mt-1 text-xs text-white/60">{station.description}</div>
          {station.action && (
            <div className="mt-2 text-sm font-semibold text-white/90">
              <span className="mr-2 inline-flex h-6 min-w-6 items-center justify-center rounded border border-white/20 bg-white/10 px-1.5 text-xs text-amber-200">E</span>
              {station.action}
            </div>
          )}
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-white/10 bg-black/45 px-4 py-2 text-xs text-white/65 backdrop-blur-sm">
        <span className="font-semibold text-white/90">WASD</span> move · <span className="font-semibold text-white/90">Shift</span> run · <span className="font-semibold text-white/90">Mouse</span> camera · <span className="font-semibold text-white/90">E</span> interact
      </div>
    </div>
  );
};
