import type { ClientMessage, ServerMessage } from '@shared/net/messages';

/**
 * Thin transport seam (Decision #2): the session client talks to `Transport`, never to
 * WebSocket directly, so WebTransport (unreliable datagrams) can slot in later without
 * touching the protocol layer.
 */

export type TransportState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Transport {
  readonly state: TransportState;
  connect(): void;
  /** Deliberate shutdown — disables auto-reconnect. */
  close(): void;
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onState(handler: (state: TransportState) => void): void;
}

// Exponential backoff for reconnects: 0.5s → 8s (+ jitter so two tabs don't sync-stampede).
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private _state: TransportState = 'idle';
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    // Not open → drop. The protocol layer re-handshakes on every (re)open, so nothing
    // queued here could be valid on the next socket anyway.
  }

  private open(during: TransportState): void {
    this.setState(during);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.reconnectAttempt = 0;
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      try {
        // Server is trusted — a `type` sanity check, not full schema validation.
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
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

/** Realtime endpoint: env override, else localhost in dev / production WSS in builds. */
export const realtimeUrl = (): string =>
  (import.meta.env.VITE_REALTIME_URL as string | undefined) ??
  (import.meta.env.DEV ? 'ws://localhost:8090/realtime' : 'wss://gamedash.workdash.site/realtime');
