import { makeHello, type ServerMessage } from '@shared/net/messages';
import { MS_PER_TICK, SNAPSHOT_HZ } from '@shared/net/constants';
import { SNAP_KEYFRAME } from '@shared/net/snapshot';
import { SessionManager, type Session, type SessionPlayer } from './session';
import { ClientConnection, type SocketLike } from './connection';
import { BotClient, makeRng, type BotClientOptions } from './botClient';
import { silentLogger } from './log';

/**
 * VIRTUAL-CLOCK integration harness (Phase 3, Task 6): the REAL server stack
 * (SessionManager → ClientConnection → PlayerInputQueue → stepSim → snapshot codec) wired
 * to the REAL bot prediction client through a simulated wire (delay ± jitter, loss),
 * driven by a deterministic event queue — two simulated minutes run in well under a
 * second, so the phase KPI is machine-measurable in CI.
 *
 * Loss model: WebSocket rides TCP, so "loss" in production manifests as delay, never
 * omission. The loss knob here DROPS droppable frames outright — input packets (stressing
 * the redundancy + jitter buffer) and delta snapshots (stressing keyframe-relative
 * decoding). JSON control frames and keyframes are delayed but never dropped, mirroring
 * the reliable channel.
 */

interface ScheduledEvent {
  t: number;
  seq: number;
  fn: () => void;
}

export class VirtualClock {
  t = 0;
  private seq = 0;
  private readonly heap: ScheduledEvent[] = [];

  at(time: number, fn: () => void): void {
    const ev = { t: Math.max(time, this.t), seq: this.seq++, fn };
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(h[i]!, h[p]!)) {
        [h[i], h[p]] = [h[p]!, h[i]!];
        i = p;
      } else break;
    }
  }

  every(intervalMs: number, fn: () => void, phaseMs = 0): void {
    const tickAt = (t: number) => {
      fn();
      this.at(t + intervalMs, () => tickAt(t + intervalMs));
    };
    this.at(this.t + phaseMs + intervalMs, () => tickAt(this.t + phaseMs + intervalMs));
  }

  /** Run events until the clock passes `untilMs`. */
  run(untilMs: number): void {
    while (this.heap.length > 0 && this.heap[0]!.t <= untilMs) {
      const ev = this.pop();
      this.t = ev.t;
      ev.fn();
    }
    this.t = untilMs;
  }

  private pop(): ScheduledEvent {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l]!, h[m]!)) m = l;
        if (r < h.length && before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

const before = (a: ScheduledEvent, b: ScheduledEvent): boolean =>
  a.t < b.t || (a.t === b.t && a.seq < b.seq);

export interface WireConditions {
  delayMs: number;
  jitterMs: number;
  /** Probability a droppable frame is lost, per frame. */
  loss: number;
}

/** One direction of a simulated TCP-ish pipe: delay ± jitter, order-preserving. */
class SimPipe {
  private lastRelease = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly rng: () => number,
    private readonly conditions: WireConditions,
    private readonly deliver: (payload: string | ArrayBuffer) => void,
  ) {}

  send(payload: string | ArrayBuffer, droppable: boolean): void {
    const { delayMs, jitterMs, loss } = this.conditions;
    if (droppable && this.rng() < loss) return;
    const delay = delayMs + (this.rng() * 2 - 1) * jitterMs;
    const release = Math.max(this.clock.t + Math.max(0, delay), this.lastRelease + 1e-6);
    this.lastRelease = release; // TCP never reorders
    this.clock.at(release, () => this.deliver(payload));
  }
}

export interface HarnessBot {
  bot: BotClient;
  player: SessionPlayer;
  conn: ClientConnection;
  /** Impulse messages the bot received (owner copies carry seq). */
  impulses: { tick: number; seq?: number }[];
}

export interface HarnessOptions {
  conditions: WireConditions;
  bots: BotClientOptions[];
  rngSeed?: number;
  /** Move the session into the expedition zone right after setup (combat integration). */
  zone?: 'hub' | 'expedition';
}

/**
 * The full loop: server sim at 30 Hz + snapshots at 20 Hz + N bots ticking at 30 Hz
 * (phase-offset from the server, as real clients are), each behind its own SimPipe pair.
 */
export class NetHarness {
  readonly clock = new VirtualClock();
  readonly manager: SessionManager;
  readonly session: Session;
  readonly bots: HarnessBot[] = [];

  constructor(opts: HarnessOptions) {
    this.manager = new SessionManager({ now: () => this.clock.t, log: silentLogger });

    let session: Session | null = null;
    for (let i = 0; i < opts.bots.length; i += 1) {
      const bot = new BotClient(opts.bots[i]);
      const entry: HarnessBot = { bot, player: null as never, conn: null as never, impulses: [] };

      // Server → bot pipe (JSON control + binary snapshots).
      const down = new SimPipe(this.clock, makeRng((opts.rngSeed ?? 1) * 31 + i * 7 + 1), opts.conditions, (payload) => {
        if (typeof payload === 'string') {
          const msg = JSON.parse(payload) as ServerMessage;
          if (msg.type === 'impulse') {
            entry.impulses.push({ tick: msg.tick, seq: msg.seq });
            bot.onImpulse(msg.seq, msg.impulse, msg.staggerMs);
          } else {
            bot.onServerMessage(msg); // combat events: loot tally, monster despawns…
          }
          return;
        }
        bot.onSnapshot(payload);
      });

      const socket: SocketLike = {
        send: (data) => {
          if (typeof data === 'string') {
            down.send(data, false); // reliable control channel
          } else {
            // Delta snapshots are droppable (stateless vs keyframe); keyframes are not.
            const keyframe = (new DataView(data).getUint8(1) & SNAP_KEYFRAME) !== 0;
            down.send(data, !keyframe);
          }
        },
        close: () => {},
      };
      const conn = new ClientConnection(socket, this.manager, () => this.clock.t, silentLogger);
      entry.conn = conn;

      // Drive the REAL protocol: hello → create/join, exactly like a browser client.
      conn.handleRaw(JSON.stringify(makeHello(`Bot${i}`, 'hero')));
      if (!session) {
        conn.handleRaw(JSON.stringify({ type: 'createSession' }));
      } else {
        conn.handleRaw(JSON.stringify({ type: 'joinSession', code: session.code }));
      }
      if (!conn.session || !conn.player) throw new Error('harness join failed');
      session = conn.session;
      entry.player = conn.player;

      // Bot → server pipe (binary input packets; droppable) through the real decode path.
      const up = new SimPipe(this.clock, makeRng((opts.rngSeed ?? 1) * 17 + i * 13 + 5), opts.conditions, (payload) => {
        if (typeof payload !== 'string') conn.handleBinary(payload);
      });
      // Client fixed tick, phase-offset so bot and server ticks interleave realistically.
      this.clock.every(MS_PER_TICK, () => up.send(bot.tick(), true), 7 + i * 3);

      this.bots.push(entry);
    }
    this.session = session!;

    // Enter the expedition zone (party-wide) before the loops run, so the very first server
    // step is authoritative combat and bots (which predict in expedition mode) stay aligned.
    if (opts.zone === 'expedition') this.session.enterZone('expedition');

    // Server loops.
    this.clock.every(MS_PER_TICK, () => this.manager.stepAll(MS_PER_TICK / 1000));
    this.clock.every(1000 / SNAPSHOT_HZ, () => this.session.broadcastSnapshots(), 11);
  }

  run(untilMs: number): void {
    this.clock.run(untilMs);
  }
}
