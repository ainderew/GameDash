import { useUIStore } from '@/ui/store';

/**
 * Live ping card (explicit user request): every session member with their EWMA RTT,
 * always on screen while in a session. PLAIN DOM (React + Tailwind, like the rest of
 * the HUD overlay) — NEVER three.js/canvas text. Re-renders are inherently throttled
 * through the store: roster at ~1 Hz (sessionState), own ping every 2 s heartbeat.
 * Player-facing surface only — the Phase 3 F3 debug overlay shares the RTT source,
 * not this component.
 */

/** Green < 60 ms, yellow < 120 ms, red ≥ 120 ms. */
const pingColor = (ping: number): string =>
  ping < 60 ? 'text-emerald-400' : ping < 120 ? 'text-amber-300' : 'text-red-400';

const PingValue = ({ ping, greyed }: { ping: number | null; greyed: boolean }) => {
  if (greyed || ping === null) {
    return <span className="font-mono text-xs text-white/35">—</span>;
  }
  return (
    <span className={`font-mono text-xs font-semibold ${pingColor(ping)}`}>
      {Math.round(ping)} ms
    </span>
  );
};

export const PingCard = () => {
  const session = useUIStore((s) => s.session);
  const connectionState = useUIStore((s) => s.connectionState);
  if (!session) return null;

  // While reconnecting every value is stale — grey the card out (spec).
  const greyed = connectionState !== 'connected';
  const self = session.members.find((m) => m.id === session.playerId);
  const others = session.members.filter((m) => m.id !== session.playerId);

  return (
    <div
      data-testid="ping-card"
      className="pointer-events-none absolute bottom-4 right-4 select-none rounded-lg border border-white/10 bg-black/55 px-3.5 py-2.5 shadow-lg backdrop-blur-sm"
    >
      <div className="mb-1 flex items-center justify-between gap-6">
        <span className="text-[0.6rem] font-semibold uppercase tracking-[0.25em] text-white/45">
          Session
        </span>
        <span className="font-mono text-[0.7rem] font-bold tracking-[0.2em] text-teal-300">
          {session.code}
        </span>
      </div>
      {greyed && (
        <div className="mb-1 text-[0.6rem] uppercase tracking-widest text-amber-300/80">
          reconnecting…
        </div>
      )}
      {others.length === 0 ? (
        // Solo in session: collapse to just your own ping.
        <div className="flex items-center justify-between gap-6">
          <span className="text-xs text-white/70">ping</span>
          <PingValue ping={self?.ping ?? null} greyed={greyed} />
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {[...(self ? [self] : []), ...others].map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-6">
              <span className="max-w-36 truncate text-xs text-white/80">
                {m.name}
                {m.id === session.playerId && <span className="text-white/40"> (you)</span>}
              </span>
              <PingValue ping={m.ping} greyed={greyed || !m.connected} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
