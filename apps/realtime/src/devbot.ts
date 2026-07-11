import WebSocket from 'ws';
import type { ServerMessage, RelayedTransform } from '@shared/net/messages';
import { makeHello } from '@shared/net/messages';
import { DEFAULT_REALTIME_PORT, REALTIME_PATH, TRANSFORM_RELAY_HZ } from '@shared/net/constants';

/**
 * Integration harness: two headless fake clients against a RUNNING realtime server.
 * Proves the Phase 2 acceptance criteria machine-verifiably (no browser needed):
 *   1. create + join by code,
 *   2. both peers receive each other's relayed transforms,
 *   3. heartbeat produces live ping values in sessionState,
 *   4. teleports are clamped server-side,
 *   5. closing one client despawns it for the other (playerLeft) within 5 s.
 *
 * Run:  pnpm --filter @friendslop/realtime devbot   (server must be up on :8090)
 * Exit code 0 = all assertions passed.
 */

const url = process.env.REALTIME_URL ?? `ws://localhost:${DEFAULT_REALTIME_PORT}${REALTIME_PATH}`;

interface Bot {
  name: string;
  ws: WebSocket;
  playerId: string | null;
  code: string | null;
  received: ServerMessage[];
  transformsByPeer: Map<string, RelayedTransform[]>;
  pings: number; // server pings answered
  ownPing: number | null;
  send: (msg: unknown) => void;
}

const makeBot = (name: string): Promise<Bot> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const bot: Bot = {
      name,
      ws,
      playerId: null,
      code: null,
      received: [],
      transformsByPeer: new Map(),
      pings: 0,
      ownPing: null,
      send: (msg) => ws.send(JSON.stringify(msg)),
    };
    ws.on('open', () => resolve(bot));
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      bot.received.push(msg);
      if (msg.type === 'welcome') {
        bot.playerId = msg.playerId;
        bot.code = msg.session.code;
      } else if (msg.type === 'ping') {
        bot.pings += 1;
        if (msg.yourPing !== null) bot.ownPing = msg.yourPing;
        bot.send({ type: 'pong', t: msg.t });
      } else if (msg.type === 'transformBatch') {
        for (const tf of msg.transforms) {
          const list = bot.transformsByPeer.get(tf.id) ?? [];
          list.push(tf);
          bot.transformsByPeer.set(tf.id, list);
        }
      }
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (label: string, cond: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
};

const results: { check: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ check: name, pass, detail });
  console.log(JSON.stringify({ check: name, pass, detail }));
};

const main = async () => {
  console.log(JSON.stringify({ event: 'devbot_start', url }));

  // ── 1. Create + join by code ────────────────────────────────────────────────
  const alice = await makeBot('alice');
  alice.send(makeHello('Alice', 'hero'));
  alice.send({ type: 'createSession' });
  await waitFor('alice welcome', () => alice.code !== null);
  check('create_session', alice.code !== null, `code=${alice.code}`);

  const bob = await makeBot('bob');
  bob.send(makeHello('Bob', 'druid'));
  bob.send({ type: 'joinSession', code: alice.code! });
  await waitFor('bob welcome', () => bob.playerId !== null);
  const bobWelcome = bob.received.find((m) => m.type === 'welcome');
  check(
    'join_by_code_roster',
    bobWelcome?.type === 'welcome' && bobWelcome.session.members.length === 2,
  );
  await waitFor(
    'alice sees playerJoined',
    () => alice.received.some((m) => m.type === 'playerJoined' && m.member.name === 'Bob'),
  );
  check('player_joined_broadcast', true);

  // ── 2. Transform relay both ways ────────────────────────────────────────────
  const publishMs = 1000 / TRANSFORM_RELAY_HZ;
  let t = 0;
  const publisher = setInterval(() => {
    t += publishMs / 1000;
    // Both walk plausible paths (≈2 u/s) from distinct origins.
    alice.send({ type: 'transformUpdate', p: [2 * t, 0, -5], r: 0.3, a: 0 });
    bob.send({ type: 'transformUpdate', p: [-3, 0, 2 * t], r: -1.2, a: 1 });
  }, publishMs);

  await waitFor(
    'both receive peer transforms',
    () =>
      (alice.transformsByPeer.get(bob.playerId!)?.length ?? 0) >= 5 &&
      (bob.transformsByPeer.get(alice.playerId!)?.length ?? 0) >= 5,
  );
  const bobSeenByAlice = alice.transformsByPeer.get(bob.playerId!)!;
  const lastBob = bobSeenByAlice[bobSeenByAlice.length - 1]!;
  check(
    'relay_bidirectional',
    Math.abs(lastBob.p[0] - -3) < 0.01 && lastBob.a === 1 && Math.abs(lastBob.r - -1.2) < 1e-9,
    `alice got ${bobSeenByAlice.length} of bob's transforms, last p=[${lastBob.p.map((v) => v.toFixed(2)).join(',')}]`,
  );
  const noEcho = !alice.transformsByPeer.has(alice.playerId!) && !bob.transformsByPeer.has(bob.playerId!);
  check('no_self_echo', noEcho);
  check(
    'timestamps_monotonic',
    bobSeenByAlice.every((tf, i) => i === 0 || tf.t >= bobSeenByAlice[i - 1]!.t),
  );

  // ── 3. Teleport clamp ───────────────────────────────────────────────────────
  clearInterval(publisher);
  await sleep(200); // let in-flight legit updates flush
  const countBefore = bobSeenByAlice.length;
  const before = bobSeenByAlice[countBefore - 1]!;
  bob.send({ type: 'transformUpdate', p: [500, 0, 500], r: 0, a: 0 });
  await waitFor('clamped teleport arrives', () => bobSeenByAlice.length > countBefore);
  const after = bobSeenByAlice[bobSeenByAlice.length - 1]!;
  const jump = Math.hypot(after.p[0] - before.p[0], after.p[2] - before.p[2]);
  check('teleport_clamped', jump < 20, `displacement after 500,500 teleport attempt: ${jump.toFixed(2)}u`);

  // ── 4. Heartbeat pings → live ping values ───────────────────────────────────
  await waitFor('two heartbeat rounds', () => alice.pings >= 2 && bob.pings >= 2, 10_000);
  await waitFor(
    'sessionState carries numeric pings for both members',
    () =>
      alice.received.some(
        (m) => m.type === 'sessionState' && m.members.length === 2 && m.members.every((x) => typeof x.ping === 'number'),
      ),
    10_000,
  );
  const lastState = [...alice.received].reverse().find((m) => m.type === 'sessionState');
  check(
    'pings_measured',
    lastState?.type === 'sessionState' &&
      lastState.members.every((m) => typeof m.ping === 'number' && m.ping! >= 0 && m.ping! < 1000),
    lastState?.type === 'sessionState'
      ? lastState.members.map((m) => `${m.name}=${m.ping?.toFixed(1)}ms`).join(' ')
      : 'no sessionState',
  );
  check('own_ping_echoed', alice.ownPing !== null && bob.ownPing !== null, `alice=${alice.ownPing} bob=${bob.ownPing}`);

  // ── 5. Kill one tab → other sees departure within 5 s ───────────────────────
  const closeAt = Date.now();
  bob.ws.terminate();
  await waitFor(
    'alice sees bob leave',
    () => alice.received.some((m) => m.type === 'playerLeft' && m.playerId === bob.playerId),
    5000,
  );
  check('despawn_within_5s', true, `${Date.now() - closeAt}ms after terminate`);

  // ── 6. Rejoin works ─────────────────────────────────────────────────────────
  const bob2 = await makeBot('bob2');
  bob2.send(makeHello('Bob', 'druid'));
  bob2.send({ type: 'joinSession', code: alice.code! });
  await waitFor('bob rejoin welcome', () => bob2.playerId !== null);
  check('rejoin_works', bob2.playerId !== null);
  bob2.ws.close();

  alice.ws.close();

  const failed = results.filter((r) => !r.pass);
  console.log(
    JSON.stringify({ event: 'devbot_done', passed: results.length - failed.length, failed: failed.length }),
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(JSON.stringify({ event: 'devbot_error', error: String(err) }));
  process.exit(1);
});
