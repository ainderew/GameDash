import { useUIStore } from '@/ui/store';

/**
 * "Reconnecting…" overlay (Phase 6 Task 3). The transport auto-reconnects with backoff and
 * resumes the session via the resume token; while it's trying, the connection state is
 * `reconnecting` and this dims the screen with a spinner so a Wi-Fi blip reads as a brief
 * pause, not a freeze. On success the session resumes seamlessly (the overlay vanishes); past
 * the grace window the client falls out to the menu with a rejoin hint (handled in client.ts).
 * Plain DOM/Tailwind over the canvas — never three.js.
 */
export const ReconnectOverlay = () => {
  const connectionState = useUIStore((s) => s.connectionState);
  const session = useUIStore((s) => s.session);
  // Only meaningful once we're actually in a session (mid-game blip), not during first connect.
  if (!session || connectionState !== 'reconnecting') return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-black/70 px-10 py-8 shadow-2xl">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-teal-300" />
        <div className="text-lg font-semibold tracking-wide text-white/90">Reconnecting…</div>
        <div className="max-w-xs text-center text-xs text-white/50">
          Holding your spot in session{' '}
          <span className="font-mono font-bold tracking-[0.2em] text-teal-300">{session.code}</span>.
          Your teammates can see you as link-dead until you're back.
        </div>
      </div>
    </div>
  );
};
