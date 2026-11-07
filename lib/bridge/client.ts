/**
 * Browser client for the Al Haq local bridge.
 *
 * Browsers cannot open raw TCP sockets or print silently, so the optional
 * bridge runs on `127.0.0.1` and exposes a small JSON WebSocket API. Every
 * request has an `id`; the bridge answers with `{ type: "response" }` and
 * pushes unsolicited `{ type: "event" }` messages (scale data, errors, close).
 */

import {
  BRIDGE_COMMANDS,
  type BridgeEventMessage,
  type BridgeHealth,
  type BridgeMessage,
  type BridgePrinter,
  type BridgeRequestMessage,
} from "./protocol";
import { DEFAULT_BRIDGE_URL } from "@/lib/scale-settings";

export type BridgeStatus = "idle" | "connecting" | "connected" | "disconnected";

export interface BridgeClientOptions {
  url?: string;
  /** Reconnect automatically after a previously successful connection. */
  autoReconnect?: boolean;
  onStatus?: (status: BridgeStatus) => void;
}

type EventHandler = (payload: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class BridgeUnavailableError extends Error {
  constructor(message = "The local bridge is not running. Start Al Haq Local Bridge on this computer and try again.") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

function makeId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() || `req-${Math.random().toString(36).slice(2)}`;
  } catch {
    return `req-${Math.random().toString(36).slice(2)}`;
  }
}

export class BridgeClient {
  readonly url: string;
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<EventHandler>>();
  private statusListeners = new Set<(status: BridgeStatus) => void>();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private everConnected = false;
  private _status: BridgeStatus = "idle";

  constructor(private options: BridgeClientOptions = {}) {
    this.url = options.url || DEFAULT_BRIDGE_URL;
  }

  get status(): BridgeStatus {
    return this._status;
  }

  private setStatus(status: BridgeStatus) {
    if (this._status === status) return;
    this._status = status;
    this.options.onStatus?.(status);
    for (const listener of this.statusListeners) listener(status);
  }

  onStatus(listener: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  on(event: string, handler: EventHandler): () => void {
    const handlers = this.listeners.get(event) || new Set<EventHandler>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.listeners.delete(event);
    };
  }

  /** Opens the WebSocket, resolving once the handshake completes. */
  connect(timeoutMs = 4000): Promise<void> {
    if (typeof window === "undefined") return Promise.reject(new BridgeUnavailableError("The local bridge is only available in the browser."));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch {
        this.setStatus("disconnected");
        reject(new BridgeUnavailableError());
        return;
      }
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* already closed */ }
        this.setStatus("disconnected");
        reject(new BridgeUnavailableError(`Could not reach the local bridge at ${this.url}.`));
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.socket = socket;
        this.everConnected = true;
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        resolve();
      };
      socket.onmessage = (message) => this.handleMessage(message);
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.setStatus("disconnected");
        reject(new BridgeUnavailableError(`Could not reach the local bridge at ${this.url}.`));
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        this.rejectAll(new BridgeUnavailableError("The local bridge connection closed."));
        this.setStatus("disconnected");
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new BridgeUnavailableError(`Could not reach the local bridge at ${this.url}.`));
        }
        this.scheduleReconnect();
      };
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private scheduleReconnect() {
    if (this.disposed || this.options.autoReconnect === false || !this.everConnected) return;
    if (typeof window === "undefined" || this.reconnectTimer != null) return;
    const delay = Math.min(10_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private handleMessage(message: MessageEvent) {
    let parsed: BridgeMessage;
    try {
      parsed = JSON.parse(String(message.data)) as BridgeMessage;
    } catch {
      return;
    }
    if (parsed.type === "event") {
      this.emit(parsed);
      return;
    }
    if (parsed.type !== "response") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    window.clearTimeout(pending.timer);
    if (parsed.ok) pending.resolve(parsed.result);
    else pending.reject(new Error(parsed.error || "The local bridge rejected the request."));
  }

  private emit(event: BridgeEventMessage) {
    const handlers = this.listeners.get(event.event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event.payload || {});
      } catch {
        /* A listener error must not break other listeners. */
      }
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request<T = unknown>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new BridgeUnavailableError();
    const id = makeId();
    const message: BridgeRequestMessage = { id, command, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The local bridge did not answer "${command}" in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify(message));
      } catch {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeUnavailableError());
      }
    });
  }

  async health(): Promise<BridgeHealth> {
    return this.request<BridgeHealth>(BRIDGE_COMMANDS.health, {}, 3500);
  }

  async listPrinters(): Promise<BridgePrinter[]> {
    const result = await this.request<{ printers?: BridgePrinter[] }>(BRIDGE_COMMANDS.printList, {}, 8000);
    return result?.printers || [];
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAll(new BridgeUnavailableError("The local bridge client was closed."));
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
    this.setStatus("disconnected");
    this.listeners.clear();
    this.statusListeners.clear();
  }
}

let sharedClient: BridgeClient | null = null;
let sharedUrl = DEFAULT_BRIDGE_URL;

/** Get the shared bridge client, reusing the socket across components. */
export function getBridgeClient(url = sharedUrl): BridgeClient {
  if (!sharedClient || sharedUrl !== url) {
    sharedClient?.dispose();
    sharedUrl = url;
    sharedClient = new BridgeClient({ url, autoReconnect: true });
  }
  return sharedClient;
}

/** Quick reachability check used by settings screens. */
export async function probeBridge(url = sharedUrl): Promise<BridgeHealth | null> {
  const client = new BridgeClient({ url, autoReconnect: false });
  try {
    return await client.health();
  } catch {
    return null;
  } finally {
    client.dispose();
  }
}
