import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_REALTIME_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  REALTIME_PATH,
  SESSION_STATE_INTERVAL_MS,
  SIM_HZ,
  SNAPSHOT_HZ,
} from '@shared/net/constants';
import { createSimStepper } from '@sim/loop';
import { logger } from './log';
import { SessionManager } from './session';
import { ClientConnection } from './connection';

/**
 * apps/realtime entrypoint: HTTP server (/healthz) + ws upgrade on /realtime.
 * Rooms/protocol are hand-rolled on `ws` per Decision #3 (no Colyseus).
 *
 * Phase 3: every session's GameWorld is stepped here at a FIXED 30 Hz through the same
 * `createSimStepper` the client uses (drift-corrected accumulator — wall-clock jitter in
 * the interval never leaks into sim dt), and snapshots broadcast at 20 Hz. The sim never
 * reads Date.now(); its clock is `session.tick × MS_PER_TICK`.
 */

const port = Number(process.env.REALTIME_PORT ?? process.env.PORT ?? DEFAULT_REALTIME_PORT);
const startedAt = Date.now();

const manager = new SessionManager();
const connections = new Map<WebSocket, ClientConnection>();

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        uptimeMs: Date.now() - startedAt,
        sessions: manager.sessionCount,
        players: manager.playerCount,
        connections: connections.size,
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== REALTIME_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const conn = new ClientConnection(
    { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
    manager,
  );
  connections.set(ws, conn);
  logger.info('ws_connected', { connections: connections.size });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // ws hands us a Buffer — slice out the exact ArrayBuffer region it views.
      const buf = data as Buffer;
      conn.handleBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    } else {
      conn.handleRaw(data.toString());
    }
  });
  ws.on('close', () => {
    connections.delete(ws);
    conn.handleClose();
    logger.info('ws_closed', { connections: connections.size });
  });
  ws.on('error', (err) => logger.warn('ws_error', { error: String(err) }));
});

// ── Authoritative sim: fixed 30 Hz over all sessions (drift-corrected). ───────
const stepper = createSimStepper({ hz: SIM_HZ, maxStepsPerAdvance: 10 });
let lastSimAdvance = performance.now();
setInterval(() => {
  const now = performance.now();
  const elapsedSec = (now - lastSimAdvance) / 1000;
  lastSimAdvance = now;
  stepper.advance(elapsedSec, (fixedDt) => manager.stepAll(fixedDt));
}, 1000 / SIM_HZ / 2).unref();

// ── Snapshot broadcast: 20 Hz per session (keyframe cadence handled inside). ──
setInterval(() => {
  for (const session of manager.allSessions()) session.broadcastSnapshots();
}, 1000 / SNAPSHOT_HZ).unref();

// ── Heartbeat: 2 s ping to every connection; drop peers that stopped ponging. ──
setInterval(() => {
  for (const [ws, conn] of connections) {
    if (conn.isStale(HEARTBEAT_TIMEOUT_MS)) {
      logger.warn('heartbeat_timeout', { playerId: conn.player?.id });
      ws.terminate();
      continue;
    }
    conn.sendHeartbeat();
  }
}, HEARTBEAT_INTERVAL_MS).unref();

// ── ~1 Hz roster/ping broadcast (feeds every client's PingCard). ──────────────
setInterval(() => {
  const serverTime = Date.now();
  for (const session of manager.allSessions()) {
    if (session.players.size === 0) continue;
    session.broadcast({
      type: 'sessionState',
      code: session.code,
      members: session.memberInfos(),
      serverTime,
    });
  }
}, SESSION_STATE_INTERVAL_MS).unref();

// ── Session GC sweep. ─────────────────────────────────────────────────────────
setInterval(() => manager.gcSweep(), 10_000).unref();

httpServer.listen(port, () => {
  logger.info('realtime_listening', { port, path: REALTIME_PATH });
});
