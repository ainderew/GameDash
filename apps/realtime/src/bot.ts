import WebSocket from 'ws';
import type { ServerMessage } from '@shared/net/messages';
import { makeHello } from '@shared/net/messages';
import { DEFAULT_REALTIME_PORT, MS_PER_TICK, REALTIME_PATH } from '@shared/net/constants';
import { SNAP_KEYFRAME } from '@shared/net/snapshot';
import { createSimStepper } from '@sim/loop';
import { BotClient, makeRng } from './botClient';

/**
 * Headless bot over a REAL WebSocket (Phase 3, Task 6): joins a session and runs the
 * REAL PredictionEngine with scripted inputs behind simulated latency/jitter/loss —
 * the KPI soak harness (the fast virtual-clock twin lives in netcode.integration.test.ts).
 *
 * Run:  pnpm --filter @friendslop/realtime bot          (server must be up on :8090)
 * Env:  REALTIME_URL · BOT_MS (default 120000) · BOT_DELAY_MS (150) · BOT_JITTER_MS (30)
 *       · BOT_LOSS (0.01) · BOT_SEED (1)
 * Exits 0 when the no-rubberband KPI holds: corrections < 1/min, every correction
 * < 10 cm, final server↔prediction convergence within epsilon.
 */

const url = process.env.REALTIME_URL ?? `ws://localhost:${DEFAULT_REALTIME_PORT}${REALTIME_PATH}`;
const durationMs = Number(process.env.BOT_MS ?? 120_000);
const delayMs = Number(process.env.BOT_DELAY_MS ?? 150);
const jitterMs = Number(process.env.BOT_JITTER_MS ?? 30);
const loss = Number(process.env.BOT_LOSS ?? 0.01);
const seed = Number(process.env.BOT_SEED ?? 1);

const rng = makeRng(seed * 7919 + 17);

/** One direction of simulated adversity, order-preserving (TCP semantics). */
const makePipe = (deliver: (data: string | ArrayBuffer) => void) => {
  let lastRelease = 0;
  return (data: string | ArrayBuffer, droppable: boolean) => {
    if (droppable && rng() < loss) return;
    const delay = Math.max(0, delayMs + (rng() * 2 - 1) * jitterMs);
    const release = Math.max(Date.now() + delay, lastRelease + 0.01);
    lastRelease = release;
    setTimeout(() => deliver(data), release - Date.now());
  };
};

const main = async () => {
  const bot = new BotClient({ seed });
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const toServer = makePipe((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  const fromServer = makePipe((data) => {
    if (typeof data === 'string') {
      const msg = JSON.parse(data) as ServerMessage;
      if (msg.type === 'impulse') bot.onImpulse(msg.seq, msg.impulse);
      else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      else if (msg.type === 'welcome') {
        console.log(JSON.stringify({ event: 'bot_joined', code: msg.session.code, playerId: msg.playerId }));
      } else if (msg.type === 'error') {
        console.error(JSON.stringify({ event: 'bot_server_error', msg }));
        process.exit(1);
      }
    } else {
      bot.onSnapshot(data);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // binaryType 'arraybuffer' hands us an ArrayBuffer directly; guard Buffer anyway.
      const ab =
        data instanceof ArrayBuffer
          ? data
          : ((data as Buffer).buffer.slice(
              (data as Buffer).byteOffset,
              (data as Buffer).byteOffset + (data as Buffer).byteLength,
            ) as ArrayBuffer);
      // Deltas droppable, keyframes reliable (mirrors the harness loss model).
      const keyframe = (new DataView(ab).getUint8(1) & SNAP_KEYFRAME) !== 0;
      fromServer(ab, !keyframe);
    } else {
      fromServer(data.toString(), false);
    }
  });

  // Control channel skips the adversity pipe both ways for join (reliable-by-construction).
  ws.send(JSON.stringify(makeHello('KpiBot', 'hero')));
  ws.send(
    JSON.stringify(
      process.env.BOT_JOIN_CODE
        ? { type: 'joinSession', code: process.env.BOT_JOIN_CODE }
        : { type: 'createSession' },
    ),
  );

  // Fixed 30 Hz client tick through the same stepper the browser uses.
  const stepper = createSimStepper({ hz: 1000 / MS_PER_TICK });
  let last = Date.now();
  const interval = setInterval(() => {
    const now = Date.now();
    stepper.advance((now - last) / 1000, () => toServer(bot.tick(), true));
    last = now;
  }, MS_PER_TICK / 2);

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(interval);
  await new Promise((r) => setTimeout(r, 500)); // drain in-flight acks

  const s = bot.stats;
  const minutes = durationMs / 60_000;
  const perMin = s.corrections.length / minutes;
  const maxCorrection = s.corrections.reduce((m, c) => Math.max(m, c.magnitudeM), 0);
  const report = {
    event: 'bot_kpi',
    durationMs,
    conditions: { delayMs, jitterMs, loss },
    ticks: s.ticks,
    acks: s.acks,
    corrections: s.corrections.length,
    correctionsPerMin: Number(perMin.toFixed(3)),
    maxCorrectionM: Number(maxCorrection.toFixed(4)),
    teleports: s.teleports,
    lastAckErrorM: Number(s.lastAckErrorM.toFixed(5)),
    maxCleanErrorM: Number(s.maxCleanErrorM.toFixed(5)),
  };
  console.log(JSON.stringify(report));

  const pass = perMin < 1 && maxCorrection < 0.1 && s.lastAckErrorM < 0.02 && s.acks > 0;
  console.log(JSON.stringify({ event: 'bot_done', pass }));
  ws.close();
  process.exit(pass ? 0 : 1);
};

main().catch((err) => {
  console.error(JSON.stringify({ event: 'bot_error', error: String(err) }));
  process.exit(1);
});
