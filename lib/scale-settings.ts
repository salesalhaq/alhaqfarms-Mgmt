export const SCALE_SETTINGS_KEY = "pos.scale.settings";
export const LEGACY_SCALE_SETTINGS_KEY = "pos.serialScale.settings";
export const SCALE_DEVICE_ID_KEY = "pos.device.id";

/** Default local bridge address used for Ethernet scales and silent printing. */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:47654";

export type ScaleConnection = "serial" | "ethernet";
export type ScaleProtocol = "ascii" | "modbus-rtu" | "modbus-tcp";
export type ScaleUnit = "auto" | "kg" | "g" | "lb" | "ltr" | "ml";
export type ScaleParity = "none" | "even" | "odd";
export type ScaleRegisterType = "holding" | "input";
export type ScaleValueType = "uint16" | "int16" | "uint32" | "int32" | "float32";
export type ScaleByteOrder = "ABCD" | "BADC" | "CDAB" | "DCBA";

export interface ScaleSettings {
  connection: ScaleConnection;
  protocol: ScaleProtocol;
  baudRate: number;
  dataBits: 7 | 8;
  parity: ScaleParity;
  stopBits: 1 | 2;
  unit: ScaleUnit;
  command: string;
  pollMs: number;
  asciiPattern: string;
  host: string;
  tcpPort: number;
  unitId: number;
  registerType: ScaleRegisterType;
  registerAddress: number;
  registerCount: 1 | 2;
  valueType: ScaleValueType;
  byteOrder: ScaleByteOrder;
  scaleFactor: number;
  offset: number;
  /** WebSocket address of the local Al Haq bridge (Ethernet scale + printing). */
  bridgeUrl: string;
}

export const DEFAULT_SCALE_SETTINGS: Readonly<ScaleSettings> = Object.freeze({
  connection: "serial",
  protocol: "ascii",
  baudRate: 9600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  unit: "auto",
  command: "",
  pollMs: 500,
  asciiPattern: "",
  host: "",
  tcpPort: 502,
  unitId: 1,
  registerType: "holding",
  registerAddress: 0,
  registerCount: 2,
  valueType: "float32",
  byteOrder: "ABCD",
  scaleFactor: 1,
  offset: 0,
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

/** Stable identifier for this browser/device, used to scope local settings. */
export function getDeviceId(storage: Storage | null = storageOrNull()): string {
  if (!storage) return "server";
  const existing = storage.getItem(SCALE_DEVICE_ID_KEY);
  if (existing) return existing;
  let generated = "";
  try {
    generated = globalThis.crypto?.randomUUID?.() || "";
  } catch {
    generated = "";
  }
  if (!generated) generated = `device-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  storage.setItem(SCALE_DEVICE_ID_KEY, generated);
  return generated;
}

export interface ScaleStorageOptions {
  branchId?: string | null;
  deviceId?: string;
  storage?: Storage | null;
}

function scopedKey(branchId: string | null | undefined, deviceId: string): string {
  return `${SCALE_SETTINGS_KEY}.${branchId || "shared"}.${deviceId}`;
}

function parseSettings(raw: string | null): Partial<ScaleSettings> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<ScaleSettings>
      : null;
  } catch {
    return null;
  }
}

/**
 * Loads scale settings for this branch + device. Falls back to the legacy
 * device-wide key so existing installs keep their configuration.
 */
export function loadScaleSettings(options: ScaleStorageOptions = {}): ScaleSettings {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  if (!storage) return { ...DEFAULT_SCALE_SETTINGS };
  const deviceId = options.deviceId || getDeviceId(storage);
  const key = scopedKey(options.branchId, deviceId);
  const scoped = parseSettings(storage.getItem(key));
  if (scoped) return { ...DEFAULT_SCALE_SETTINGS, ...scoped };
  const legacy = parseSettings(storage.getItem(SCALE_SETTINGS_KEY))
    || parseSettings(storage.getItem(LEGACY_SCALE_SETTINGS_KEY));
  if (legacy) {
    const migrated = { ...DEFAULT_SCALE_SETTINGS, ...legacy };
    storage.setItem(key, JSON.stringify(migrated));
    return migrated;
  }
  return { ...DEFAULT_SCALE_SETTINGS };
}

/** Saves scale settings for this branch + device. */
export function saveScaleSettings(settings: ScaleSettings, options: ScaleStorageOptions = {}): void {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  if (!storage) return;
  const deviceId = options.deviceId || getDeviceId(storage);
  storage.setItem(scopedKey(options.branchId, deviceId), JSON.stringify(settings));
  // Keep the legacy key in sync so older code paths read the same values.
  storage.setItem(SCALE_SETTINGS_KEY, JSON.stringify(settings));
}

export function validateScaleSettings(settings: ScaleSettings): ScaleSettings {
  if (!["serial", "ethernet"].includes(settings.connection)) throw new Error("Choose a supported scale connection.");
  if (!["ascii", "modbus-rtu", "modbus-tcp"].includes(settings.protocol)) throw new Error("Choose a supported scale protocol.");
  if (settings.connection === "serial" && settings.protocol === "modbus-tcp") {
    throw new Error("Modbus TCP requires an Ethernet connection.");
  }
  if (settings.connection === "ethernet" && settings.protocol === "modbus-rtu") {
    throw new Error("Modbus RTU requires a serial connection.");
  }
  if (!["auto", "kg", "g", "lb", "ltr", "ml"].includes(settings.unit)) throw new Error("Choose a supported scale unit.");
  const baudRate = Number(settings.baudRate);
  if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 115200) {
    throw new Error("Serial baud rate must be between 1200 and 115200.");
  }
  const dataBits = Number(settings.dataBits);
  if (!Number.isInteger(dataBits) || ![7, 8].includes(dataBits)) throw new Error("Serial data bits must be 7 or 8.");
  if (!["none", "even", "odd"].includes(settings.parity)) throw new Error("Choose a valid serial parity.");
  const stopBits = Number(settings.stopBits);
  if (!Number.isInteger(stopBits) || ![1, 2].includes(stopBits)) throw new Error("Serial stop bits must be 1 or 2.");
  const pollMs = Number(settings.pollMs);
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60000) {
    throw new Error("Poll interval must be between 100 and 60000 milliseconds.");
  }
  const unitId = Number(settings.unitId);
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 247) {
    throw new Error("Modbus unit ID must be between 0 and 247.");
  }
  const registerAddress = Number(settings.registerAddress);
  if (!Number.isInteger(registerAddress) || registerAddress < 0 || registerAddress > 65535) {
    throw new Error("Register address must be between 0 and 65535.");
  }
  const registerCount = Number(settings.registerCount);
  if (!Number.isInteger(registerCount) || registerCount < 1 || registerCount > 2) {
    throw new Error("Register count must be 1 or 2.");
  }
  if (!["uint16", "int16", "uint32", "int32", "float32"].includes(settings.valueType)) {
    throw new Error("Choose a supported Modbus data type.");
  }
  const expectedRegisterCount = ["uint16", "int16"].includes(settings.valueType) ? 1 : 2;
  if (registerCount !== expectedRegisterCount) {
    throw new Error(`${settings.valueType} requires ${expectedRegisterCount} Modbus register${expectedRegisterCount === 1 ? "" : "s"}.`);
  }
  if (!["ABCD", "BADC", "CDAB", "DCBA"].includes(settings.byteOrder)) throw new Error("Choose a supported byte order.");
  const scaleFactor = Number(settings.scaleFactor);
  const offset = Number(settings.offset);
  if (!Number.isFinite(scaleFactor) || !Number.isFinite(offset)) {
    throw new Error("Modbus scale factor and offset must be valid numbers.");
  }
  if (settings.connection === "ethernet") {
    if (!String(settings.host || "").trim()) throw new Error("Enter the scale IP address or host name.");
    const tcpPort = Number(settings.tcpPort);
    if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
      throw new Error("TCP port must be between 1 and 65535.");
    }
  }
  const bridgeUrl = String(settings.bridgeUrl || DEFAULT_BRIDGE_URL).trim();
  if (!/^wss?:\/\/[^\s]+$/i.test(bridgeUrl)) {
    throw new Error("The local bridge address must start with ws:// or wss://.");
  }
  if (settings.asciiPattern) {
    try {
      new RegExp(settings.asciiPattern);
    } catch {
      throw new Error("ASCII pattern must be a valid regular expression.");
    }
  }
  return {
    ...settings,
    baudRate,
    dataBits: dataBits as 7 | 8,
    stopBits: stopBits as 1 | 2,
    pollMs,
    tcpPort: Number(settings.tcpPort),
    unitId,
    registerAddress,
    registerCount: registerCount as 1 | 2,
    scaleFactor,
    offset,
    bridgeUrl,
  };
}
