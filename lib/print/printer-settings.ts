/**
 * Per-device printer preferences. Stored locally because printer queues are
 * physical properties of the computer, not of the cloud account. A future
 * `device_settings` cloud table can sync these without changing this model.
 */

import { DEFAULT_BRIDGE_URL, getDeviceId } from "@/lib/scale-settings";

export const PRINTER_SETTINGS_KEY = "pos.printers.settings";

export interface PrinterSettings {
  /** Empty string means "use the system default printer". */
  receiptPrinter: string;
  reportPrinter: string;
  labelPrinter: string;
  receiptCopies: number;
  autoPrintReceipt: boolean;
  silentPrint: boolean;
  labelSizeId: string;
  bridgeUrl: string;
}

export const DEFAULT_PRINTER_SETTINGS: Readonly<PrinterSettings> = Object.freeze({
  receiptPrinter: "",
  reportPrinter: "",
  labelPrinter: "",
  receiptCopies: 1,
  autoPrintReceipt: false,
  silentPrint: true,
  labelSizeId: "50x30",
  bridgeUrl: DEFAULT_BRIDGE_URL,
});

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface PrinterStorageOptions {
  branchId?: string | null;
  deviceId?: string;
  storage?: Storage | null;
}

function scopedKey(branchId: string | null | undefined, deviceId: string): string {
  return `${PRINTER_SETTINGS_KEY}.${branchId || "shared"}.${deviceId}`;
}

export function loadPrinterSettings(options: PrinterStorageOptions = {}): PrinterSettings {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  if (!storage) return { ...DEFAULT_PRINTER_SETTINGS };
  const deviceId = options.deviceId || getDeviceId(storage);
  const raw = storage.getItem(scopedKey(options.branchId, deviceId)) || storage.getItem(PRINTER_SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_PRINTER_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<PrinterSettings>;
    return { ...DEFAULT_PRINTER_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

export function savePrinterSettings(settings: PrinterSettings, options: PrinterStorageOptions = {}): void {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  if (!storage) return;
  const deviceId = options.deviceId || getDeviceId(storage);
  const normalized: PrinterSettings = {
    ...settings,
    receiptCopies: Math.max(1, Math.min(10, Math.trunc(Number(settings.receiptCopies) || 1))),
    labelSizeId: settings.labelSizeId || DEFAULT_PRINTER_SETTINGS.labelSizeId,
    bridgeUrl: settings.bridgeUrl || DEFAULT_BRIDGE_URL,
  };
  storage.setItem(scopedKey(options.branchId, deviceId), JSON.stringify(normalized));
  storage.setItem(PRINTER_SETTINGS_KEY, JSON.stringify(normalized));
}

export function validatePrinterSettings(settings: PrinterSettings): PrinterSettings {
  const bridgeUrl = String(settings.bridgeUrl || "").trim();
  if (!/^wss?:\/\/[^\s]+$/i.test(bridgeUrl)) {
    throw new Error("The local bridge address must start with ws:// or wss://.");
  }
  const copies = Number(settings.receiptCopies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) {
    throw new Error("Receipt copies must be between 1 and 10.");
  }
  return { ...settings, bridgeUrl, receiptCopies: copies };
}
