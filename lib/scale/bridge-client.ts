/**
 * Ethernet TCP scale transport over the Al Haq local bridge.
 *
 * Mirrors the Electron `scale:tcp:*` IPC commands and events so the same
 * `SerialScale` component can drive USB-serial and Ethernet scales.
 */

import {
  BridgeUnavailableError,
  getBridgeClient,
  type BridgeClient,
} from "@/lib/bridge/client";
import { BRIDGE_COMMANDS, BRIDGE_EVENTS } from "@/lib/bridge/protocol";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface ScaleBridgeEvents {
  onData?: (bytes: Uint8Array) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export class BridgeScaleConnection {
  private unsubscribers: Array<() => void> = [];
  private closed = false;

  constructor(
    readonly connectionId: string,
    private bridge: BridgeClient = getBridgeClient(),
    events: ScaleBridgeEvents = {},
  ) {
    const matches = (payload: Record<string, unknown>) => payload.connectionId === this.connectionId;
    if (events.onData) {
      this.unsubscribers.push(this.bridge.on(BRIDGE_EVENTS.scaleData, (payload) => {
        if (!matches(payload) || typeof payload.data !== "string") return;
        try {
          events.onData?.(base64ToBytes(payload.data));
        } catch {
          events.onError?.("The scale sent data that could not be decoded.");
        }
      }));
    }
    if (events.onError) {
      this.unsubscribers.push(this.bridge.on(BRIDGE_EVENTS.scaleError, (payload) => {
        if (!matches(payload)) return;
        events.onError?.(typeof payload.message === "string" ? payload.message : "The scale connection failed.");
      }));
    }
    if (events.onClose) {
      this.unsubscribers.push(this.bridge.on(BRIDGE_EVENTS.scaleClosed, (payload) => {
        if (!matches(payload)) return;
        this.closed = true;
        events.onClose?.();
      }));
    }
  }

  async connect(host: string, port: number): Promise<void> {
    if (typeof window === "undefined") throw new BridgeUnavailableError();
    try {
      await this.bridge.request(BRIDGE_COMMANDS.scaleConnect, {
        connectionId: this.connectionId,
        host,
        port,
      });
    } catch (error) {
      if (error instanceof BridgeUnavailableError) throw error;
      throw new Error(error instanceof Error ? error.message : "Could not connect to the Ethernet scale.");
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("The Ethernet scale connection is closed.");
    await this.bridge.request(BRIDGE_COMMANDS.scaleWrite, {
      connectionId: this.connectionId,
      data: bytesToBase64(bytes),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.bridge.request(BRIDGE_COMMANDS.scaleClose, { connectionId: this.connectionId }, 5000);
    } catch {
      /* The socket may already be gone. */
    }
  }

  dispose() {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }
}
