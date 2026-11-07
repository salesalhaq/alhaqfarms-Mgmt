#!/usr/bin/env node
/**
 * Al Haq Local Bridge
 *
 * A tiny loopback service that gives the web app two things browsers cannot do
 * on their own:
 *   1. raw TCP sockets for Ethernet weighing scales;
 *   2. silent printing to a chosen Windows printer.
 *
 * It only listens on 127.0.0.1 and checks the browser Origin. Run it with:
 *   cd bridge && npm install && npm start
 */

"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { WebSocketServer, WebSocket } = require("ws");

const VERSION = "1.0.0";
const SERVICE = "alhaq-local-bridge";
const PORT = Number(process.env.BRIDGE_PORT || 47654);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const scaleConnections = new Map();
let pdfToPrinter = null;
try {
  // Optional at startup so scale-only installations still work.
  pdfToPrinter = require("pdf-to-printer");
} catch {
  pdfToPrinter = null;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function originAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function send(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    log("Could not send bridge message:", error.message);
  }
}

function sendEvent(ws, event, payload) {
  send(ws, { type: "event", event, payload });
}

function asString(value, label, maxLength = 4096) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function asInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function asBase64(value) {
  const text = String(value ?? "");
  if (!text) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("Scale data must be base64 encoded.");
  return Buffer.from(text, "base64");
}

/* ------------------------------------------------------------------ scale */

function closeScaleConnection(connectionId) {
  const connection = scaleConnections.get(connectionId);
  if (!connection) return false;
  scaleConnections.delete(connectionId);
  try {
    connection.socket.destroy();
  } catch {
    /* already destroyed */
  }
  return true;
}

function connectScale(ws, payload) {
  const connectionId = asString(payload.connectionId, "Scale connection ID", 253);
  if (!/^[\w.-]{1,253}$/.test(connectionId)) throw new Error("Invalid scale connection ID.");
  const host = asString(payload.host, "Scale host", 253);
  if (/[\s/\\]/.test(host)) throw new Error("Enter a valid scale host name or IP address.");
  const port = asInteger(payload.port, "TCP port", 1, 65535);

  closeScaleConnection(connectionId);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to the scale at ${host}:${port}.`));
    }, 8000);

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scaleConnections.set(connectionId, { socket, ws });
      resolve({ connected: true, connectionId });
    });
    socket.on("data", (data) => {
      sendEvent(ws, "scale.tcp.data", { connectionId, data: data.toString("base64") });
    });
    socket.on("error", (error) => {
      sendEvent(ws, "scale.tcp.error", { connectionId, message: error.message || "Scale socket error." });
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(error.message || `Could not connect to the scale at ${host}:${port}.`));
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const existing = scaleConnections.get(connectionId);
      if (existing && existing.socket === socket) scaleConnections.delete(connectionId);
      sendEvent(ws, "scale.tcp.closed", { connectionId });
    });
  });
}

function writeScale(payload) {
  const connectionId = asString(payload.connectionId, "Scale connection ID", 253);
  const connection = scaleConnections.get(connectionId);
  if (!connection) throw new Error("The Ethernet scale is not connected.");
  const data = asBase64(payload.data);
  if (data.length > 64 * 1024) throw new Error("Scale command is too large.");
  return new Promise((resolve, reject) => {
    connection.socket.write(data, (error) => {
      if (error) reject(new Error(error.message || "Could not write to the scale."));
      else resolve({ written: data.length });
    });
  });
}

/* ------------------------------------------------------------------ print */

let printQueue = Promise.resolve();
function enqueuePrint(task) {
  const run = printQueue.then(task, task);
  printQueue = run.catch(() => undefined);
  return run;
}

function requirePrinterLibrary() {
  if (!pdfToPrinter) {
    throw new Error("Silent printing needs the optional 'pdf-to-printer' package. Run `npm install` inside the bridge folder.");
  }
  return pdfToPrinter;
}

async function listPrinters() {
  const library = requirePrinterLibrary();
  const printers = await library.getPrinters();
  return (printers || []).map((printer) => ({
    name: printer.name,
    isDefault: Boolean(printer.isDefault),
    status: printer.status || "",
  }));
}

function findBrowser() {
  const candidates = [
    process.env.BRIDGE_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || "";
}

function renderHtmlToPdf(html) {
  return new Promise((resolve, reject) => {
    const browser = findBrowser();
    if (!browser) {
      reject(new Error("Microsoft Edge or Google Chrome was not found. Install one, or set BRIDGE_BROWSER to its executable path."));
      return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alhaq-bridge-"));
    const htmlPath = path.join(directory, "document.html");
    const pdfPath = path.join(directory, "document.pdf");
    const profilePath = path.join(directory, "profile");
    fs.writeFileSync(htmlPath, html, "utf8");
    const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
    execFile(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--print-to-pdf-no-header",
        `--user-data-dir=${profilePath}`,
        `--print-to-pdf=${pdfPath}`,
        fileUrl,
      ],
      { windowsHide: true, timeout: 90_000 },
      (error) => {
        if (error && !fs.existsSync(pdfPath)) {
          reject(new Error(`Could not render the print document: ${error.message}`));
          return;
        }
        if (!fs.existsSync(pdfPath)) {
          reject(new Error("The print document was not produced."));
          return;
        }
        resolve({ directory, pdfPath });
      },
    );
  });
}

async function printHtml(payload) {
  const html = String(payload.html || "");
  if (!html.trim()) throw new Error("No print document was supplied.");
  if (html.length > 12_000_000) throw new Error("The print document is too large.");
  const printerName = String(payload.printer || "").trim();
  const copies = Math.max(1, Math.min(10, Math.trunc(Number(payload.copies) || 1)));

  const library = requirePrinterLibrary();
  if (printerName) {
    const printers = await library.getPrinters();
    if (!(printers || []).some((printer) => printer.name === printerName)) {
      throw new Error(`Printer "${printerName}" was not found on this computer.`);
    }
  }

  return enqueuePrint(async () => {
    const rendered = await renderHtmlToPdf(html);
    try {
      await library.print(rendered.pdfPath, {
        printer: printerName || undefined,
        copies,
        silent: true,
      });
      return { printed: true, printer: printerName || "system default", copies };
    } finally {
      try {
        fs.rmSync(rendered.directory, { recursive: true, force: true });
      } catch {
        /* temporary files are best-effort */
      }
    }
  });
}

/* --------------------------------------------------------------- commands */

async function handleCommand(ws, command, payload) {
  switch (command) {
    case "health":
      return {
        ok: true,
        service: SERVICE,
        version: VERSION,
        platform: `${process.platform} ${process.arch}`,
        printers: pdfToPrinter ? (await listPrinters()).length : 0,
      };
    case "scale.tcp.connect":
      return connectScale(ws, payload);
    case "scale.tcp.write":
      return writeScale(payload);
    case "scale.tcp.close": {
      const connectionId = asString(payload.connectionId, "Scale connection ID", 253);
      return { closed: closeScaleConnection(connectionId) };
    }
    case "print.list":
      return { printers: await listPrinters() };
    case "print.html":
    case "print.receipt":
    case "print.labels":
      return printHtml(payload);
    default:
      throw new Error(`Unknown bridge command "${command}".`);
  }
}

/* ----------------------------------------------------------------- server */

const server = http.createServer((request, response) => {
  const origin = request.headers.origin || "";
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": originAllowed(origin) && origin ? origin : "null",
    "Vary": "Origin",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...headers,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }
  if (request.url === "/health" || request.url === "/") {
    response.writeHead(200, headers);
    response.end(JSON.stringify({
      ok: true,
      service: SERVICE,
      version: VERSION,
      platform: `${process.platform} ${process.arch}`,
      printing: Boolean(pdfToPrinter),
      connections: scaleConnections.size,
    }));
    return;
  }
  response.writeHead(404, headers);
  response.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info) => originAllowed(info.origin),
});

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "response", id: "", ok: false, error: "Bridge messages must be JSON." });
      return;
    }
    if (!message || typeof message.id !== "string" || typeof message.command !== "string") {
      send(ws, { type: "response", id: "", ok: false, error: "Bridge messages need an id and command." });
      return;
    }
    try {
      const result = await handleCommand(ws, message.command, message.payload || {});
      send(ws, { type: "response", id: message.id, ok: true, result });
    } catch (error) {
      send(ws, {
        type: "response",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : "Bridge command failed.",
      });
    }
  });
  ws.on("close", () => {
    for (const [connectionId, connection] of scaleConnections) {
      if (connection.ws === ws) closeScaleConnection(connectionId);
    }
  });
});

server.listen(PORT, HOST, () => {
  log(`Al Haq Local Bridge ${VERSION} listening on ws://${HOST}:${PORT}`);
  log(pdfToPrinter
    ? "Silent printing is available."
    : "Silent printing is unavailable until `npm install` installs pdf-to-printer.");
  log(`Allowed browser origins: localhost/127.0.0.1${ALLOWED_ORIGINS.length ? `, ${ALLOWED_ORIGINS.join(", ")}` : ""}`);
});

function shutdown() {
  log("Shutting down…");
  for (const connectionId of [...scaleConnections.keys()]) closeScaleConnection(connectionId);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
