import type { ScaleSettings } from "./scale-settings";

const UNIT_PATTERN = /([-+]?\s*\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs|oz|ltr|l|ml)?/i;

export interface ParsedReading {
  value: number;
  unit: string;
}

export function encodeCommand(command: string): Uint8Array {
  const normalized = String(command || "")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return new TextEncoder().encode(normalized);
}

export function parseAsciiReading(raw: string, pattern = ""): ParsedReading | null {
  const text = String(raw || "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (!text || /(^|[\s,])US([\s,]|$)/i.test(text) || text.startsWith("?")) return null;
  const expression = pattern
    ? new RegExp(pattern, `${new RegExp(pattern).flags.replace("g", "")}g`)
    : new RegExp(UNIT_PATTERN.source, "ig");
  const matches = [...text.matchAll(expression)];
  const match = matches.at(-1);
  const captured = pattern ? match?.[1] : match?.[0];
  if (!captured) return null;
  const quantity = Number.parseFloat(String(captured).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(quantity)) return null;
  const unitMatch = pattern
    ? [...text.matchAll(/\b(kg|g|lb|lbs|oz|ltr|l|ml)\b/ig)].at(-1)?.[1]
    : match?.[2];
  return { value: quantity, unit: unitMatch || "" };
}

export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export function buildModbusRtuRequest({
  unitId,
  registerType,
  registerAddress,
  registerCount,
}: Pick<ScaleSettings, "unitId" | "registerType" | "registerAddress" | "registerCount">): Uint8Array {
  const request = new Uint8Array([
    Number(unitId) & 0xff,
    registerType === "input" ? 4 : 3,
    (Number(registerAddress) >> 8) & 0xff,
    Number(registerAddress) & 0xff,
    (Number(registerCount) >> 8) & 0xff,
    Number(registerCount) & 0xff,
  ]);
  const crc = crc16Modbus(request);
  return Uint8Array.from([...request, crc & 0xff, crc >> 8]);
}

export function buildModbusTcpRequest({
  transactionId,
  unitId,
  registerType,
  registerAddress,
  registerCount,
}: Pick<ScaleSettings, "unitId" | "registerType" | "registerAddress" | "registerCount"> & { transactionId: number }): Uint8Array {
  const functionCode = registerType === "input" ? 4 : 3;
  return Uint8Array.from([
    (transactionId >> 8) & 0xff, transactionId & 0xff, 0, 0, 0, 6,
    Number(unitId) & 0xff, functionCode,
    (Number(registerAddress) >> 8) & 0xff, Number(registerAddress) & 0xff,
    (Number(registerCount) >> 8) & 0xff, Number(registerCount) & 0xff,
  ]);
}

function orderedBytes(data: Uint8Array, byteOrder: ScaleSettings["byteOrder"]): Uint8Array {
  if (byteOrder === "ABCD" || data.length === 2) return data;
  if (byteOrder === "BADC") return Uint8Array.from([data[1], data[0], ...data.slice(2)]);
  if (byteOrder === "CDAB") return Uint8Array.from([...data.slice(2), ...data.slice(0, 2)]);
  return Uint8Array.from([...data].reverse());
}

export function decodeModbusRegisters(
  registerBytes: Uint8Array,
  { valueType, byteOrder, scaleFactor = 1, offset = 0 }: Pick<ScaleSettings, "valueType" | "byteOrder" | "scaleFactor" | "offset">,
): number {
  const expectedLength = ["uint16", "int16"].includes(valueType) ? 2 : 4;
  if (registerBytes.length < expectedLength) throw new Error(`The scale returned too few bytes for ${valueType}.`);
  const bytes = orderedBytes(registerBytes.slice(0, expectedLength), byteOrder);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = valueType === "uint16" ? view.getUint16(0)
    : valueType === "int16" ? view.getInt16(0)
      : valueType === "uint32" ? view.getUint32(0)
        : valueType === "int32" ? view.getInt32(0)
          : valueType === "float32" ? view.getFloat32(0)
            : NaN;
  const value = raw * Number(scaleFactor) + Number(offset);
  if (!Number.isFinite(value)) throw new Error("The Modbus reading is not a finite number.");
  return value;
}

export function parseModbusRtuFrame(frame: Uint8Array, settings: ScaleSettings): number {
  if (frame.length < 5) throw new Error("Modbus RTU response is incomplete.");
  const expectedCrc = crc16Modbus(frame.slice(0, -2));
  const actualCrc = (frame.at(-2) ?? 0) | ((frame.at(-1) ?? 0) << 8);
  if (expectedCrc !== actualCrc) throw new Error("Modbus RTU response has an invalid CRC.");
  if (frame[0] !== Number(settings.unitId)) throw new Error("Modbus RTU response came from a different unit ID.");
  if (frame[1] & 0x80) throw new Error(`Modbus exception ${frame[2]}.`);
  const expectedFunction = settings.registerType === "input" ? 4 : 3;
  const expectedBytes = ["uint16", "int16"].includes(settings.valueType) ? 2 : 4;
  if (frame[1] !== expectedFunction || frame[2] !== expectedBytes || frame.length !== 5 + expectedBytes) {
    throw new Error("Modbus RTU response does not match the configured register type.");
  }
  return decodeModbusRegisters(frame.slice(3, 3 + frame[2]), settings);
}

export function parseModbusTcpFrame(frame: Uint8Array, transactionId: number, settings: ScaleSettings): number {
  if (frame.length < 9) throw new Error("Modbus TCP response is incomplete.");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint16(0) !== transactionId) throw new Error("Modbus TCP response transaction does not match.");
  if (view.getUint16(2) !== 0) throw new Error("Modbus TCP response has an invalid protocol ID.");
  const length = view.getUint16(4);
  if (frame.length < 6 + length) throw new Error("Modbus TCP response frame is incomplete.");
  if (frame[6] !== Number(settings.unitId)) throw new Error("Modbus TCP response came from a different unit ID.");
  if (frame[7] & 0x80) throw new Error(`Modbus exception ${frame[8]}.`);
  const expectedFunction = settings.registerType === "input" ? 4 : 3;
  const expectedBytes = ["uint16", "int16"].includes(settings.valueType) ? 2 : 4;
  if (frame[7] !== expectedFunction || frame[8] !== expectedBytes || length !== 3 + expectedBytes) {
    throw new Error("Modbus TCP response does not match the configured register type.");
  }
  return decodeModbusRegisters(frame.slice(9, 6 + length), settings);
}

export function quantityInUnit(value: number, sourceUnit: string, targetUnit: string, configuredUnit = "auto"): number {
  const source = String(sourceUnit || configuredUnit || "kg").toLowerCase();
  const sourceDimension = ["kg", "g", "lb", "lbs", "oz"].includes(source) ? "mass" : "volume";
  const targetDimension = targetUnit === "kg" ? "mass" : "volume";
  if (sourceDimension !== targetDimension) {
    throw new Error(`Scale reports ${sourceDimension}; ${targetUnit} requires a ${targetDimension} reading.`);
  }
  const quantity = targetUnit === "kg"
    ? source === "g" ? value / 1000
      : source === "lb" || source === "lbs" ? value * 0.45359237
        : source === "oz" ? value * 0.028349523
          : value
    : source === "ml" ? value / 1000 : value;
  return Math.round(quantity * 1000) / 1000;
}
