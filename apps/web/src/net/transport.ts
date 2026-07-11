import type { ClientMessage, ServerMessage } from '@shared/net/messages';
import { netStats } from '@/net/netStats';

/**
 * Thin transport seam (Decision #2): the session client talks to `Transport`, never to
 * WebSocket directly, so WebTransport (unreliable datagrams) can slot in later without
 * touching the protocol layer. Phase 3 adds the BINARY hot path (input packets up,
 * snapshots down) and a dev latency simulator (`?net=150ms±30,loss1%`) so every later
 * phase is developed AT latency, not at localhost-zero.
 */

export type TransportState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Transport {
  readonly state: TransportState;
  connect(): void;
  /** Deliberate shutdown — disables auto-reconnect. */
  close(): void;
  send(msg: ClientMessage): void;
  /** Hot path: binary frames (input packets). Dropped silently while not open. */
  sendBinary(data: ArrayBuffer): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onBinary(handler: (data: ArrayBuffer) => void): void;
  onState(handler: (state: TransportState) => void): void;
}

// Exponential backoff for reconnects: 0.5s → 8s (+ jitter so two tabs don't sync-stampede).
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private _state: TransportState = 'idle';
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
  private binaryHandler: ((data: ArrayBuffer) => void) | null = null;
  private stateHandler: ((state: TransportState) => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(private readonly url: string) {}

  get state(): TransportState {
    return this._state;
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onBinary(handler: (data: ArrayBuffer) => void): void {
    this.binaryHandler = handler;
  }

  onState(handler: (state: TransportState) => void): void {
    this.stateHandler = handler;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.open(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, 'client closed');
    this.ws = null;
    this.setState('closed');
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(msg);
      netStats.bytesOut += data.length;
      this.ws.send(data);
    }
    // Not open → drop. The protocol layer re-handshakes on every (re)open, so nothing
    // queued here could be valid on the next socket anyway.
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      netStats.bytesOut += data.byteLength;
      this.ws.send(data);
    }
  }

  private open(during: TransportState): void {
    this.setState(during);
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.reconnectAttempt = 0;
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      if (ev.data instanceof ArrayBuffer) {
        netStats.bytesIn += ev.data.byteLength;
        this.binaryHandler?.(ev.data);
        return;
      }
      try {
        // Server is trusted — a `type` sanity check, not full schema validation.
        const raw = String(ev.data);
        netStats.bytesIn += raw.length;
        const msg = JSON.parse(raw) as ServerMessage;
        if (typeof msg === 'object' && msg !== null && typeof msg.type === 'string') {
          this.messageHandler?.(msg);
        }
      } catch {
        // Unparseable server frame — ignore.
      }
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows — reconnect is handled there.
    };
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const delay =
      Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempt, BACKOFF_MAX_MS) * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open('reconnecting'), delay);
  }

  private setState(state: TransportState): void {
    if (state === this._state) return;
    this._state = state;
    this.stateHandler?.(state);
  }
}

// ── Dev latency harness ───────────────────────────────────────────────────────

export interface NetConditions {
  delayMs: number;
  jitterMs: number;
  /** Probability [0,1] a HOT-PATH (binary) frame is dropped. */
  loss: number;
}

/**
 * Parse `?net=150ms±30,loss1%` (also accepts `+-` for `±`). Null when absent/invalid.
 * Examples: `?net=150ms` · `?net=80ms±20` · `?net=150ms+-30,loss1%` · `?net=loss2%`.
 */
export const parseNetConditions = (search: string): NetConditions | null => {
  const param = new URLSearchParams(search).get('net');
  if (!param) return null;
  const out: NetConditions = { delayMs: 0, jitterMs: 0, loss: 0 };
  let any = false;
  for (const part of param.split(',')) {
    const delay = /^(\d+(?:\.\d+)?)ms(?:(?:±|\+-)(\d+(?:\.\d+)?))?$/.exec(part.trim());
    if (delay) {
      out.delayMs = Number(delay[1]);
      out.jitterMs = delay[2] ? Number(delay[2]) : 0;
      any = true;
      continue;
    }
    const loss = /^loss(\d+(?:\.\d+)?)%$/.exec(part.trim());
    if (loss) {
      out.loss = Number(loss[1]) / 100;
      any = true;
    }
  }
  return any ? out : null;
};

/**
 * Wraps a Transport with artificial delay ± jitter and hot-path loss, order-preserving
 * per direction (WSS rides TCP: real loss shows up as delay, never reordering — the drop
 * knob exists to stress input redundancy and keyframe-relative snapshot decode, so it
 * only ever discards binary frames; JSON control stays reliable).
 */
export class SimulatedLatencyTransport implements Transport {
  private lastReleaseIn = 0;
  private lastReleaseOut = 0;

  constructor(
    private readonly inner: Transport,
    private readonly conditions: NetConditions,
  ) {}

  get state(): TransportState {
    return this.inner.state;
  }

  connect(): void {
    this.inner.connect();
  }

  close(): void {
    this.inner.close();
  }

  onState(handler: (state: TransportState) => void): void {
    this.inner.onState(handler);
  }

  send(msg: ClientMessage): void {
    this.delayed('out', false, () => this.inner.send(msg));
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.dropped()) return;
    this.delayed('out', true, () => this.inner.sendBinary(data));
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.inner.onMessage((msg) => this.delayed('in', false, () => handler(msg)));
  }

  onBinary(handler: (data: ArrayBuffer) => void): void {
    this.inner.onBinary((data) => {
      // Down-path loss: drop delta snapshots only (keyframes are the delta baseline;
      // over real TCP nothing drops at all — see class doc).
      const keyframe = data.byteLength >= 2 && (new DataView(data).getUint8(1) & 1) !== 0;
      if (!keyframe && this.dropped()) return;
      this.delayed('in', true, () => handler(data));
    });
  }

  private dropped(): boolean {
    return this.conditions.loss > 0 && Math.random() < this.conditions.loss;
  }

  private delayed(dir: 'in' | 'out', _binary: boolean, fn: () => void): void {
    const { delayMs, jitterMs } = this.conditions;
    const target = performance.now() + Math.max(0, delayMs + (Math.random() * 2 - 1) * jitterMs);
    const lastKey = dir === 'in' ? 'lastReleaseIn' : 'lastReleaseOut';
    const release = Math.max(target, this[lastKey] + 0.01); // preserve TCP ordering
    this[lastKey] = release;
    setTimeout(fn, Math.max(0, release - performance.now()));
  }
}

/** Realtime endpoint: env override, else localhost in dev / production WSS in builds. */
export const realtimeUrl = (): string =>
  (import.meta.env.VITE_REALTIME_URL as string | undefined) ??
  (import.meta.env.DEV ? 'ws://localhost:8090/realtime' : 'wss://gamedash.workdash.site/realtime');

/** Build the transport, honoring the `?net=` dev harness when present. */
export const createTransport = (url: string): Transport => {
  const base = new WebSocketTransport(url);
  if (typeof window === 'undefined') return base;
  const conditions = parseNetConditions(window.location.search);
  if (!conditions) return base;
  // eslint-disable-next-line no-console
  console.info('[net] simulated conditions active', conditions);
  return new SimulatedLatencyTransport(base, conditions);
};
