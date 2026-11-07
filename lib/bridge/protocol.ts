/** Wire protocol shared by the web app and the Al Haq local bridge. */

export interface BridgeRequestMessage {
  id: string;
  command: string;
  payload?: Record<string, unknown>;
}

export type BridgeResponseMessage =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string };

export interface BridgeEventMessage {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
}

export type BridgeMessage = BridgeResponseMessage | BridgeEventMessage;

export const BRIDGE_COMMANDS = {
  health: "health",
  scaleConnect: "scale.tcp.connect",
  scaleWrite: "scale.tcp.write",
  scaleClose: "scale.tcp.close",
  printList: "print.list",
  printHtml: "print.html",
  printReceipt: "print.receipt",
  printLabels: "print.labels",
} as const;

export const BRIDGE_EVENTS = {
  scaleData: "scale.tcp.data",
  scaleError: "scale.tcp.error",
  scaleClosed: "scale.tcp.closed",
  bridgeStatus: "bridge.status",
} as const;

export interface BridgeHealth {
  ok: boolean;
  service: string;
  version: string;
  platform: string;
  printers?: number;
}

export interface BridgePrinter {
  name: string;
  isDefault?: boolean;
  status?: string;
}
