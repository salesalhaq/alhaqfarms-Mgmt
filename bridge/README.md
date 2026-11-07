# Al Haq Local Bridge

The bridge is a small loopback service for the two jobs a browser cannot do:

1. **Ethernet weighing scales** — opens raw TCP sockets to the scale and streams
   the bytes to the web app.
2. **Silent printing** — renders a receipt/label document and sends it straight
   to a chosen Windows printer, without the browser print dialog.

It listens on `127.0.0.1:47654` by default and rejects browser origins that are
not loopback unless you allow them.

## Install

```powershell
cd "E:\Alhaqfm Web\bridge"
npm install
```

`npm install` pulls in `ws` (WebSocket server) and `pdf-to-printer` (silent
Windows printing). If `pdf-to-printer` cannot be installed, scale support still
works and print requests return a clear error.

## Run

Double-click `start.cmd`, or:

```powershell
npm start
```

Keep the window open while the register is in use. The health endpoint is:

```
http://127.0.0.1:47654/health
```

## Allow the production web app

Loopback origins (`http://localhost:*`, `http://127.0.0.1:*`) are allowed by
default. To allow the deployed app, set a comma-separated list before starting:

```powershell
$env:BRIDGE_ALLOWED_ORIGINS="https://pos.alhaqfarms.com"
npm start
```

## Printers

In **Settings → Printers** choose the receipt, report, and tag printers from the
list the bridge reports. Turn on **Print silently** to bypass the browser
dialog. When the bridge is not running the app falls back to the normal browser
print dialog.

The bridge uses Microsoft Edge (or Chrome) headless to render HTML to PDF. If
neither is installed, set `BRIDGE_BROWSER` to the browser executable:

```powershell
$env:BRIDGE_BROWSER="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
npm start
```

## Protocol

Requests:

```json
{ "id": "1", "command": "scale.tcp.connect", "payload": { "connectionId": "scale-a", "host": "192.168.1.50", "port": 502 } }
{ "id": "2", "command": "scale.tcp.write",   "payload": { "connectionId": "scale-a", "data": "<base64>" } }
{ "id": "3", "command": "scale.tcp.close",   "payload": { "connectionId": "scale-a" } }
{ "id": "4", "command": "print.list",        "payload": {} }
{ "id": "5", "command": "print.html",        "payload": { "printer": "EPSON TM-T20III", "copies": 1, "html": "<!doctype html>…" } }
{ "id": "6", "command": "health",            "payload": {} }
```

Responses:

```json
{ "type": "response", "id": "1", "ok": true, "result": { "connected": true } }
{ "type": "response", "id": "1", "ok": false, "error": "…" }
```

Events:

```json
{ "type": "event", "event": "scale.tcp.data",   "payload": { "connectionId": "scale-a", "data": "<base64>" } }
{ "type": "event", "event": "scale.tcp.error",  "payload": { "connectionId": "scale-a", "message": "…" } }
{ "type": "event", "event": "scale.tcp.closed", "payload": { "connectionId": "scale-a" } }
```

`print.receipt` and `print.labels` are aliases of `print.html`.

## Run at sign-in (optional)

Create a Task Scheduler task:

- Trigger: **At log on**
- Action: start `node.exe` with argument `server.cjs`
- Start in: `E:\Alhaqfm Web\bridge`

That keeps the bridge available whenever the register is open. Use a dedicated
Windows account or the cashier's own account; the bridge only listens on
loopback.
