"use client";

import { Cable, CircleAlert, Scale, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SCALE_SETTINGS,
  loadScaleSettings,
  validateScaleSettings,
  type ScaleSettings,
} from "@/lib/scale-settings";
import {
  buildModbusRtuRequest,
  encodeCommand,
  parseAsciiReading,
  parseModbusRtuFrame,
  quantityInUnit,
} from "@/lib/scale-protocols";

type ScaleStatus = "disconnected" | "connecting" | "connected";

function makeReading(value: number, sourceUnit: string, targetUnit: string, configuredUnit: ScaleSettings["unit"]): number {
  const resolvedUnit = configuredUnit === "auto" ? targetUnit : configuredUnit;
  return quantityInUnit(value, sourceUnit, targetUnit, resolvedUnit);
}

export function SerialScale({
  unitCode = "kg",
  onUseReading,
}: {
  unitCode?: string;
  onUseReading?: (quantity: number) => void;
}) {
  const [settings, setSettings] = useState<ScaleSettings>({ ...DEFAULT_SCALE_SETTINGS });
  const [status, setStatus] = useState<ScaleStatus>("disconnected");
  const [reading, setReading] = useState<{ quantity: number; receivedAt: number; stable: boolean } | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const closingRef = useRef(false);
  const bufferRef = useRef<number[]>([]);
  const asciiBufferRef = useRef("");
  const stabilityRef = useRef<{ value: number | null; since: number }>({ value: null, since: 0 });
  const unitCodeRef = useRef(unitCode);
  const settingsRef = useRef(settings);
  const pollTimerRef = useRef<number | null>(null);

  unitCodeRef.current = unitCode;
  settingsRef.current = settings;

  useEffect(() => {
    try {
      setSettings(loadScaleSettings());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Scale settings could not be loaded.");
    }
  }, []);

  const reportReading = (amount: number, sourceUnit: string) => {
    try {
      const quantity = makeReading(amount, sourceUnit, unitCodeRef.current, settingsRef.current.unit);
      const now = Date.now();
      const previous = stabilityRef.current;
      stabilityRef.current = previous.value != null && Math.abs(previous.value - quantity) <= 0.005
        ? { value: quantity, since: previous.since }
        : { value: quantity, since: now };
      setReading({ quantity, receivedAt: now, stable: now - stabilityRef.current.since >= 700 });
      setError("");
    } catch (conversionError) {
      setError(conversionError instanceof Error ? conversionError.message : "The scale reading could not be converted.");
    }
  };

  const processAscii = (bytes: Uint8Array) => {
    const decoder = new TextDecoder();
    asciiBufferRef.current = (asciiBufferRef.current + decoder.decode(bytes, { stream: true })).slice(-512);
    const parsed = parseAsciiReading(asciiBufferRef.current, settingsRef.current.asciiPattern);
    if (parsed) reportReading(parsed.value, parsed.unit);
  };

  const processRtu = (bytes: Uint8Array) => {
    bufferRef.current.push(...bytes);
    while (bufferRef.current.length >= 5) {
      if (bufferRef.current[0] !== settingsRef.current.unitId) {
        bufferRef.current.shift();
        continue;
      }
      const functionCode = bufferRef.current[1];
      const expectedFunction = settingsRef.current.registerType === "input" ? 4 : 3;
      if (functionCode !== expectedFunction && functionCode !== (expectedFunction | 0x80)) {
        bufferRef.current.shift();
        continue;
      }
      const frameLength = functionCode & 0x80 ? 5 : 5 + bufferRef.current[2];
      if (bufferRef.current.length < frameLength) return;
      const frame = Uint8Array.from(bufferRef.current.splice(0, frameLength));
      try {
        reportReading(parseModbusRtuFrame(frame, settingsRef.current), "");
      } catch (frameError) {
        setError(frameError instanceof Error ? frameError.message : "The scale response could not be read.");
      }
    }
  };

  const processBytes = (bytes: Uint8Array) => {
    if (settingsRef.current.protocol === "ascii") processAscii(bytes);
    else if (settingsRef.current.protocol === "modbus-rtu") processRtu(bytes);
  };

  const sendRequest = async () => {
    const current = settingsRef.current;
    const port = portRef.current;
    if (!port?.writable) return;
    let request: Uint8Array | null = null;
    if (current.protocol === "ascii") {
      if (!current.command) return;
      request = encodeCommand(current.command);
    } else if (current.protocol === "modbus-rtu") {
      request = buildModbusRtuRequest(current);
    } else {
      return;
    }
    if (!request) return;
    const writer = port.writable.getWriter();
    try {
      await writer.write(request);
    } finally {
      writer.releaseLock();
    }
  };

  const disconnect = async () => {
    closingRef.current = true;
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch {
        /* The reader may already be closed. */
      }
    }
    readerRef.current = null;
    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch {
        /* The port may already be closed. */
      }
      portRef.current = null;
    }
    bufferRef.current = [];
    asciiBufferRef.current = "";
    setStatus("disconnected");
    closingRef.current = false;
  };

  useEffect(() => () => {
    void disconnect();
  }, []);

  useEffect(() => {
    if (status !== "connected") return undefined;
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        await sendRequest();
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "The scale request failed.");
      }
      if (active) pollTimerRef.current = window.setTimeout(poll, settingsRef.current.pollMs);
    };
    pollTimerRef.current = window.setTimeout(poll, 0);
    return () => {
      active = false;
      if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [status]);

  useEffect(() => {
    if (!reading) return undefined;
    const timer = window.setInterval(() => {
      setReading((current) => current && ({ ...current, stable: Date.now() - stabilityRef.current.since >= 700 }));
    }, 100);
    return () => window.clearInterval(timer);
  }, [reading?.receivedAt]);

  const connect = async () => {
    setConnecting(true);
    setError("");
    setReading(null);
    bufferRef.current = [];
    asciiBufferRef.current = "";
    try {
      const configured = validateScaleSettings(loadScaleSettings());
      setSettings(configured);
      settingsRef.current = configured;
      if (configured.connection === "ethernet") {
        throw new Error("Ethernet scales require the Windows desktop app. Use a USB-to-serial scale in the web workspace.");
      }
      if (!navigator.serial) {
        throw new Error("Web Serial is not available in this browser. Use Chrome or Edge, or connect through the Windows desktop app.");
      }
      const port = await navigator.serial.requestPort();
      await port.open({
        baudRate: configured.baudRate,
        dataBits: configured.dataBits,
        parity: configured.parity,
        stopBits: configured.stopBits,
      });
      portRef.current = port;
      closingRef.current = false;
      setStatus("connected");
      void (async () => {
        while (portRef.current === port && !closingRef.current && port.readable) {
          const reader = port.readable.getReader();
          readerRef.current = reader;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done || !value) break;
              processBytes(value);
            }
          } catch (readError) {
            if (portRef.current === port) {
              setError(readError instanceof Error ? readError.message : "Could not read from the scale.");
            }
          } finally {
            reader.releaseLock();
            if (readerRef.current === reader) readerRef.current = null;
          }
        }
      })();
    } catch (connectError) {
      await disconnect();
      setError(connectError instanceof Error ? connectError.message : "Could not connect to the scale.");
    } finally {
      setConnecting(false);
    }
  };

  const fresh = reading && Date.now() - reading.receivedAt < 2000;

  return (
    <div className="serial-scale">
      <div className="serial-scale-status">
        <span>
          {status === "connected" ? <Scale size={14} /> : <Cable size={14} />}
          <small>
            {status === "connected"
              ? reading
                ? <><strong className="stable">{reading.quantity.toFixed(3)} {unitCode}</strong><span>{reading.stable ? "Stable reading" : "Waiting for stable weight"}</span></>
                : "Connected · waiting for reading"
              : `Scale: ${settings.connection} · ${settings.protocol}`}
          </small>
        </span>
        <div className="serial-scale-actions">
          {status === "connected"
            ? <button type="button" className="secondary-button" onClick={() => void disconnect()}><Unplug size={13} /> Disconnect</button>
            : <button type="button" className="secondary-button" onClick={() => void connect()} disabled={connecting}>{connecting ? "Connecting…" : "Connect scale"}</button>}
          {reading && (
            <button type="button" className="primary-button" disabled={!fresh || !reading.stable} onClick={() => onUseReading?.(reading.quantity)}>
              Use reading
            </button>
          )}
        </div>
      </div>
      {status === "connected" && !reading && (
        <p className="serial-scale-help">Waiting for a stable scale reading. Check the scale connection and protocol settings.</p>
      )}
      {error && <div className="error-banner"><CircleAlert size={14} /> {error}</div>}
    </div>
  );
}
