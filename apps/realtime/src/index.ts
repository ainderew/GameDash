import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_REALTIME_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  REALTIME_PATH,
  SESSION_STATE_INTERVAL_MS,
  TRANSFORM_RELAY_HZ,
} from '@shared/net/constants';
import { logger } from './log';
import { SessionManager } from './session';
import { ClientConnection } from './connection';
import { flushTransforms } from './relay';

/**
 * apps/realtime entrypoint: HTTP server (/healthz) + ws upgrade on /realtime.
 * Rooms/protocol are hand-rolled on `ws` per Decision #3 (no Colyseus).
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

  ws.on('message', (data) => conn.handleRaw(data.toString()));
  ws.on('close', () => {
    connections.delete(ws);
    conn.handleClose();
    logger.info('ws_closed', { connections: connections.size });
  });
  ws.on('error', (err) => logger.warn('ws_error', { error: String(err) }));
});

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

// ── TEMPORARY Phase 2: 15 Hz hub transform relay flush (relay.ts — deleted in Phase 3).
setInterval(() => flushTransforms(manager), 1000 / TRANSFORM_RELAY_HZ).unref();

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
