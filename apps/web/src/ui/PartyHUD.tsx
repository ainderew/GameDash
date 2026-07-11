import { useUIStore, type SessionMemberUI } from '@/ui/store';

/**
 * Party roster widget (Phase 6 Task 1): a live frame of every teammate — name, HP bar,
 * relic-carrier icon, and per-member ping — anchored to the left edge. Plain DOM/Tailwind
 * over the canvas (never three.js), re-rendering only when the store's throttled session
 * state changes (roster ~1 Hz, HP on integer change, ping every 2 s heartbeat). Self-hides
 * when solo or alone in a session; the single-player PingCard still covers the solo case.
 */

const pingColor = (ping: number): string =>
  ping < 60 ? 'text-emerald-400' : ping < 120 ? 'text-amber-300' : 'text-red-400';

const hpColor = (pct: number): string =>
  pct > 50 ? 'from-teal-400 to-emerald-400' : pct > 25 ? 'from-amber-400 to-yellow-400' : 'from-rose-500 to-red-500';

const MemberRow = ({
  member,
  isSelf,
  isCarrier,
}: {
  member: SessionMemberUI;
  isSelf: boolean;
  isCarrier: boolean;
}) => {
  const hp = member.hp ?? 100;
  const pct = Math.max(0, Math.min(100, hp));
  const downed = hp <= 0;

  return (
    <div
      className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${
        isSelf ? 'border-teal-300/30 bg-teal-950/40' : 'border-white/10 bg-black/50'
      } ${!member.connected ? 'opacity-50 grayscale' : ''}`}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {isCarrier && (
            <span title="carrying the relic" className="text-sm leading-none text-fuchsia-300">
              ◆
            </span>
          )}
          <span className="max-w-28 truncate text-xs font-semibold text-white/90">{member.name}</span>
          {isSelf && <span className="text-[0.6rem] text-white/40">(you)</span>}
        </div>
        {member.ping === null || !member.connected ? (
          <span className="font-mono text-[0.65rem] text-white/35">—</span>
        ) : (
          <span className={`font-mono text-[0.65rem] font-semibold ${pingColor(member.ping)}`}>
            {Math.round(member.ping)}ms
          </span>
        )}
      </div>
      <div className="relative h-2 w-40 overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10">
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${hpColor(pct)} transition-[width] duration-200`}
          style={{ width: `${pct}%` }}
        />
        {downed && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.55rem] font-bold uppercase tracking-widest text-red-300">
            downed
          </div>
        )}
      </div>
    </div>
  );
};

export const PartyHUD = () => {
  const session = useUIStore((s) => s.session);
  const relicCarrier = useUIStore((s) => s.relicCarrier);
  if (!session || session.members.length < 2) return null;

  const self = session.members.find((m) => m.id === session.playerId);
  const others = session.members.filter((m) => m.id !== session.playerId);
  const ordered = [...(self ? [self] : []), ...others];

  return (
    <div
      data-testid="party-hud"
      className="pointer-events-none absolute left-4 top-1/2 flex -translate-y-1/2 flex-col gap-2"
    >
      <div className="mb-0.5 pl-1 text-[0.6rem] font-semibold uppercase tracking-[0.28em] text-white/40">
        Party · {session.members.length}
      </div>
      {ordered.map((m) => (
        <MemberRow
          key={m.id}
          member={m}
          isSelf={m.id === session.playerId}
          isCarrier={relicCarrier === m.id}
        />
      ))}
    </div>
  );
};
