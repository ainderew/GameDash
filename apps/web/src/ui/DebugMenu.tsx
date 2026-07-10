import { useState } from 'react';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { useUIStore } from '@/ui/store';

/**
 * Dev-only debug menu (DOM overlay, mounted next to CombatHUD). Collapsed to a small
 * "Debug" chip under the HP bar; free the cursor (Esc) to click it. Sections are meant
 * to grow — character switching lives here first.
 */
export const DebugMenu = () => {
  const [open, setOpen] = useState(false);
  const current = useUIStore((s) => s.playerCharacter);
  const setCharacter = useUIStore((s) => s.setPlayerCharacter);
  const ids = Object.keys(PLAYER_CHARACTERS) as PlayerCharacterId[];

  return (
    <div className="pointer-events-auto absolute left-4 top-20 select-none text-xs">
      <button
        className="rounded-md bg-black/50 px-3 py-1.5 font-semibold uppercase tracking-wider text-white/70 ring-1 ring-white/10 hover:bg-black/70 hover:text-white"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Debug
      </button>

      {open && (
        <div className="mt-2 w-44 rounded-lg bg-black/60 p-3 ring-1 ring-white/10 backdrop-blur-sm">
          <div className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-white/40">
            Character
          </div>
          <div className="flex flex-col gap-1">
            {ids.map((id) => (
              <button
                key={id}
                onClick={() => setCharacter(id)}
                className={
                  id === current
                    ? 'rounded bg-emerald-400/20 px-2 py-1.5 text-left font-semibold text-emerald-300 ring-1 ring-emerald-300/40'
                    : 'rounded bg-white/5 px-2 py-1.5 text-left text-white/70 ring-1 ring-white/10 hover:bg-white/15 hover:text-white'
                }
              >
                {PLAYER_CHARACTERS[id].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
