import { performance } from 'node:perf_hooks';
import { makeHello, type ServerMessage } from '@shared/net/messages';
import { MS_PER_TICK, SNAPSHOT_HZ } from '@shared/net/constants';
import { SessionManager, type Session } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { BotClient } from './botClient';
import { TickMetrics } from './metrics';
import { silentLogger } from './log';

/**
 * Scaled soak (Phase 6 Task 5). The REAL server stack (SessionManager → ClientConnection →
 * stepSim → snapshot codec) driven by the REAL bot prediction clients, in-process, at wall-clock
 * 30 Hz for SOAK_MS. Each session runs a mix of combat + relic-relay bots so the full expedition
 * loop (spawns, damage, downs, the relay) is exercised continuously. Asserts, over the run:
 *   - ZERO crashes (no process exception; no room torn down by the panic-safe isolation),
 *   - no memory-growth trend (linear-regression slope of heapUsed stays flat),
 *   - tick p99 < 15 ms (half the 33 ms budget — the Phase 6 KPI).
 *
 * Scaled DOWN from the 1-hour fleet: defaults to 4 sessions × 4 bots for ~10 minutes.
 *   pnpm --filter @friendslop/realtime soak
 *   SOAK_MS=60000 SOAK_SESSIONS=4 SOAK_BOTS=4 pnpm --filter @friendslop/realtime soak
 * Run with `node --expose-gc` for a cleaner memory trend (the harness calls gc() before sampling).
 */

const SESSIONS = Number(process.env.SOAK_SESSIONS ?? 4);
const BOTS = Number(process.env.SOAK_BOTS ?? 4);
const DURATION_MS = Number(process.env.SOAK_MS ?? 600_000);
const SAMPLE_MS = 5_000;

const manager = new SessionManager({ log: silentLogger, maxSessions: 1000 });
const tickMetrics = new TickMetrics(2000);
const conns: ClientConnection[] = [];
const bots: BotClient[] = [];
const sessions: Session[] = [];

for (let s = 0; s < SESSIONS; s += 1) {
  let session: Session | null = null;
  for (let b = 0; b < BOTS; b += 1) {
    // Front half fight; back half relay the relic — both subsystems live at once.
    const combat = b < Math.ceil(BOTS / 2);
    const bot = new BotClient({ seed: s * 100 + b + 1, mode: 'expedition', combat, relay: !combat });
    const socket: SocketLike = {
      send: (data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data) as ServerMessage;
          if (msg.type === 'impulse') bot.onImpulse(msg.seq, msg.impulse, msg.staggerMs);
          else bot.onServerMessage(msg);
        } else {
          bot.onSnapshot(data);
        }
      },
      close: () => {},
    };
    const conn = new ClientConnection(socket, manager, Date.now, silentLogger);
    conn.handleRaw(JSON.stringify(makeHello(`S${s}B${b}`, 'hero')));
    conn.handleRaw(JSON.stringify(session ? { type: 'joinSession', code: session.code } : { type: 'createSession' }));
    if (!conn.session || !conn.player) throw new Error('soak join failed');
    session = conn.session;
    conns.push(conn);
    bots.push(bot);
  }
  session!.enterZone('expedition');
  sessions.push(session!);
}

const initialSessions = manager.sessionCount;
let crashes = 0;
process.on('uncaughtException', (err) => {
  crashes += 1;
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'soak_uncaught', error: String(err) }));
});

// ── Loops (wall-clock, like the real server) ──────────────────────────────────
const simTimer = setInterval(() => {
  const t0 = performance.now();
  manager.stepAll(MS_PER_TICK / 1000); // per-room try/catch inside — a panic destroys one room
  tickMetrics.record(performance.now() - t0);
}, MS_PER_TICK);
const snapTimer = setInterval(() => manager.broadcastAll(), 1000 / SNAPSHOT_HZ);
const botTimer = setInterval(() => {
  for (let i = 0; i < conns.length; i += 1) conns[i]!.handleBinary(bots[i]!.tick());
}, MS_PER_TICK);

// ── Memory sampling → linear-regression slope ─────────────────────────────────
const mem: { tMs: number; heapMB: number }[] = [];
const started = Date.now();
const sampleTimer = setInterval(() => {
  (globalThis as { gc?: () => void }).gc?.();
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  mem.push({ tMs: Date.now() - started, heapMB });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ event: 'soak_sample', tSec: Math.round((Date.now() - started) / 1000), heapMB: Number(heapMB.toFixed(1)), sessions: manager.sessionCount, tickP99: tickMetrics.summary().p99 }),
  );
}, SAMPLE_MS);

/** Least-squares slope of heapMB over minutes. */
const memSlopePerMin = (): number => {
  if (mem.length < 2) return 0;
  const xs = mem.map((m) => m.tMs / 60_000);
  const ys = mem.map((m) => m.heapMB);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
};

setTimeout(() => {
  clearInterval(simTimer);
  clearInterval(snapTimer);
  clearInterval(botTimer);
  clearInterval(sampleTimer);

  const tick = tickMetrics.summary();
  const slope = memSlopePerMin();
  crashes += initialSessions - manager.sessionCount; // any room the isolation had to tear down
  const totalCatches = bots.reduce((a, b) => a + b.catches, 0);
  const totalMaterials = sessions.reduce((a, s) => a + s.materials, 0);
  const report = {
    event: 'soak_result',
    durationMs: DURATION_MS,
    sessions: SESSIONS,
    botsPerSession: BOTS,
    ticks: tick.samples,
    tickMs: tick,
    memory: {
      startMB: mem[0] ? Number(mem[0].heapMB.toFixed(1)) : 0,
      endMB: mem.at(-1) ? Number(mem.at(-1)!.heapMB.toFixed(1)) : 0,
      slopeMBPerMin: Number(slope.toFixed(3)),
      samples: mem.length,
      gc: typeof (globalThis as { gc?: unknown }).gc === 'function',
    },
    relayCatches: totalCatches,
    materials: totalMaterials,
    crashes,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report));

  // Pass gates: no crashes, tick p99 under budget, and a near-flat memory slope.
  const pass = crashes === 0 && tick.p99 < 15 && slope < 2 && tick.samples > 0;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'soak_done', pass }));
  process.exit(pass ? 0 : 1);
}, DURATION_MS).unref();
