import { useUIStore } from '@/ui/store';

/** Multiplayer run summary shown after the server returns a downed party to the hub. */
export const ExpeditionResults = () => {
  const result = useUIStore((s) => s.expeditionResult);
  const ownPlayerId = useUIStore((s) => s.session?.playerId);
  const dismiss = useUIStore((s) => s.setExpeditionResult);
  if (!result) return null;

  const mvp = result.standings.find((entry) => entry.playerId === result.mvpPlayerId);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#090705]/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-amber-200/25 bg-[#17120d]/95 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        <div className="border-b border-amber-100/10 bg-gradient-to-b from-amber-500/15 to-transparent px-7 py-6 text-center">
          <div className="text-[0.65rem] font-bold uppercase tracking-[0.36em] text-red-300/80">
            Hunt failed · party recovered
          </div>
          <h1 className="mt-2 text-3xl font-black tracking-wide text-amber-50">Expedition Results</h1>
          {mvp && (
            <div className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 px-5 py-4 shadow-inner">
              <div className="text-[0.65rem] font-bold uppercase tracking-[0.32em] text-amber-300">
                ★ Expedition MVP ★
              </div>
              <div className="mt-1 truncate text-2xl font-black text-white">
                {mvp.name}
                {mvp.playerId === ownPlayerId && <span className="ml-2 text-sm text-teal-300">YOU</span>}
              </div>
              <div className="mt-1 text-sm text-amber-100/70">
                {mvp.score.toLocaleString()} points · {mvp.kills} eliminations
              </div>
            </div>
          )}
        </div>

        <div className="px-7 py-5">
          <div className="mb-2 grid grid-cols-[2rem_1fr_auto_auto] gap-3 px-3 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-white/35">
            <span>#</span><span>Adventurer</span><span>Elims</span><span>Score</span>
          </div>
          <ol className="space-y-2">
            {result.standings.map((entry, index) => {
              const isMvp = entry.playerId === result.mvpPlayerId;
              const isSelf = entry.playerId === ownPlayerId;
              return (
                <li
                  key={entry.playerId}
                  className={`grid grid-cols-[2rem_1fr_auto_auto] items-center gap-3 rounded-lg border px-3 py-2.5 ${
                    isMvp
                      ? 'border-amber-300/30 bg-amber-300/10'
                      : isSelf
                        ? 'border-teal-300/25 bg-teal-400/10'
                        : 'border-white/5 bg-white/[0.035]'
                  }`}
                >
                  <span className="font-mono text-sm text-white/40">{index + 1}</span>
                  <span className="min-w-0 truncate text-sm font-semibold text-white/90">
                    {isMvp && <span className="mr-2 text-amber-300">★</span>}
                    {entry.name}
                    {isSelf && <span className="ml-2 text-[0.6rem] uppercase text-teal-300">you</span>}
                  </span>
                  <span className="min-w-12 text-right font-mono text-sm text-white/60">{entry.kills}</span>
                  <span className="min-w-20 text-right font-mono text-sm font-bold text-amber-200">
                    {entry.score.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ol>

          <button
            className="mt-5 w-full rounded-lg bg-amber-300 px-5 py-2.5 text-sm font-black uppercase tracking-[0.18em] text-[#21170a] transition hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-100"
            onClick={() => dismiss(null)}
          >
            Return to Haven
          </button>
        </div>
      </div>
    </div>
  );
};
