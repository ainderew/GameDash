import { useEffect, useRef, useState } from 'react';
import { netStats } from '@/net/netStats';
import { useUIStore } from '@/ui/store';

/**
 * F3 netcode debug overlay (Phase 3, Task 6): ping, clock offset, interp delay,
 * snapshot rate, bytes in/out, and THE phase KPI — reconciliation corrections/min +
 * magnitude (must sit near zero on a clean link; anything else is a sim-parity bug,
 * not a tuning knob). Plain DOM, polls netStats at 4 Hz — zero cost while hidden.
 */

interface Row {
  label: string;
  value: string;
  /** Highlight when the KPI is being violated. */
  bad?: boolean;
}

const fmt = (v: number | null, unit: string, digits = 0): string =>
  v === null ? '—' : `${v.toFixed(digits)}${unit}`;

export const NetDebugOverlay = () => {
  const [visible, setVisible] = useState(false);
  const [, setPulse] = useState(0);
  const lastBytes = useRef({ in: 0, out: 0, at: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F3') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      // Rolling byte rates.
      const now = performance.now();
      const prev = lastBytes.current;
      if (prev.at > 0) {
        const dtSec = (now - prev.at) / 1000;
        if (dtSec > 0) {
          netStats.bytesInPerSec = (netStats.bytesIn - prev.in) / dtSec;
          netStats.bytesOutPerSec = (netStats.bytesOut - prev.out) / dtSec;
        }
      }
      lastBytes.current = { in: netStats.bytesIn, out: netStats.bytesOut, at: now };
      setPulse((p) => p + 1);
    }, 250);
    return () => clearInterval(id);
  }, [visible]);

  const connectionState = useUIStore((s) => s.connectionState);
  if (!visible) return null;

  const perMin = netStats.correctionsPerMin();
  const rows: Row[] = [
    { label: 'link', value: connectionState },
    { label: 'ping', value: fmt(netStats.pingMs, ' ms') },
    { label: 'clock offset', value: fmt(netStats.clockOffsetMs, ' ms') },
    { label: 'interp delay', value: fmt(netStats.interpDelayMs, ' ms') },
    { label: 'snapshots', value: `${netStats.snapshotRateHz.toFixed(1)} Hz (${netStats.snapshotsReceived})` },
    { label: 'in / out', value: `${(netStats.bytesInPerSec / 1024).toFixed(1)} / ${(netStats.bytesOutPerSec / 1024).toFixed(1)} KiB/s` },
    { label: 'input seq', value: `${netStats.lastAckSeq} ack / ${netStats.headSeq} head` },
    {
      label: 'corrections',
      value: `${perMin}/min · last ${(netStats.lastCorrectionM * 100).toFixed(1)}cm · max ${(netStats.maxCorrectionM * 100).toFixed(1)}cm`,
      bad: perMin >= 1 || netStats.maxCorrectionM >= 0.1,
    },
    { label: 'teleports', value: `${netStats.teleports}` },
  ];

  return (
    <div
      data-testid="net-debug-overlay"
      className="pointer-events-none fixed left-3 top-3 z-50 min-w-[240px] rounded-md bg-black/75 p-3 font-mono text-[11px] leading-relaxed text-emerald-100 shadow-lg"
    >
      <div className="mb-1 font-bold tracking-wider text-emerald-300">NET · F3</div>
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4" data-net-row={row.label}>
          <span className="text-emerald-400/80">{row.label}</span>
          <span className={row.bad ? 'font-bold text-red-400' : ''}>{row.value}</span>
        </div>
      ))}
    </div>
  );
};
