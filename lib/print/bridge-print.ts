/**
 * Silent printing through the Al Haq local bridge.
 *
 * The bridge renders the supplied HTML with headless Edge/Chrome and sends the
 * resulting PDF to the selected Windows printer. When the bridge is absent the
 * caller falls back to the normal browser print dialog.
 */

import { BridgeUnavailableError, getBridgeClient } from "@/lib/bridge/client";
import { BRIDGE_COMMANDS, type BridgePrinter } from "@/lib/bridge/protocol";
import { loadPrinterSettings, type PrinterSettings } from "@/lib/print/printer-settings";

export interface BridgePrintResult {
  printed: boolean;
  /** True when the bridge itself could not be reached (safe to fall back). */
  bridgeUnavailable?: boolean;
  reason?: string;
}

export interface BridgePrintOptions {
  printer?: string;
  copies?: number;
  title?: string;
  /** CSS page size hint, e.g. "80mm auto" or "50mm 30mm". */
  pageSize?: string;
  bridgeUrl?: string;
}

export interface StandalonePrintDocument {
  bodyHtml: string;
  title?: string;
  /** Extra CSS appended after the app styles (usually an `@page` rule). */
  pageCss?: string;
  /** Class applied to `<html>` (e.g. `direct-label-print`). */
  htmlClass?: string;
  /** Optional wrapper class for the body content. */
  bodyClass?: string;
}

/** Collects the app's styles so a detached document prints like the app. */
export function collectDocumentCss(): string {
  if (typeof document === "undefined") return "";
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText);
    } catch {
      // Cross-origin stylesheets cannot be inspected; skip them.
    }
  }
  return chunks.join("\n");
}

export function buildStandalonePrintHtml(documentInput: StandalonePrintDocument): string {
  const css = collectDocumentCss();
  const title = documentInput.title || "Al Haq print";
  const bodyClass = documentInput.bodyClass ? ` class="${documentInput.bodyClass}"` : "";
  return `<!doctype html>
<html${documentInput.htmlClass ? ` class="${documentInput.htmlClass}"` : ""}>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
${css}
${documentInput.pageCss || ""}
</style>
</head>
<body${bodyClass}>${documentInput.bodyHtml}</body>
</html>`;
}

/** Serializes an on-screen print element into a standalone HTML document. */
export function serializeElementForBridge(
  element: Element,
  options: Omit<StandalonePrintDocument, "bodyHtml"> = {},
): string {
  return buildStandalonePrintHtml({
    ...options,
    bodyHtml: element.outerHTML,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] || character));
}

export async function listBridgePrinters(bridgeUrl?: string): Promise<BridgePrinter[]> {
  const settings = loadPrinterSettings();
  const client = getBridgeClient(bridgeUrl || settings.bridgeUrl);
  return client.listPrinters();
}

export async function printHtmlViaBridge(
  html: string,
  options: BridgePrintOptions = {},
): Promise<BridgePrintResult> {
  const settings: PrinterSettings = loadPrinterSettings();
  const bridgeUrl = options.bridgeUrl || settings.bridgeUrl;
  const client = getBridgeClient(bridgeUrl);
  try {
    await client.request(
      BRIDGE_COMMANDS.printHtml,
      {
        html,
        printer: options.printer || "",
        copies: Math.max(1, Math.min(10, Math.trunc(options.copies ?? 1))),
        title: options.title || "Al Haq print",
        pageSize: options.pageSize || "",
      },
      120_000,
    );
    return { printed: true };
  } catch (error) {
    if (error instanceof BridgeUnavailableError) {
      return {
        printed: false,
        bridgeUnavailable: true,
        reason: error.message,
      };
    }
    return {
      printed: false,
      reason: error instanceof Error ? error.message : "The local bridge could not print this document.",
    };
  }
}

/**
 * Prints a receipt element silently when the bridge and a receipt printer are
 * configured. Returns false when the caller should use the browser dialog.
 */
export async function printReceiptElementViaBridge(
  element: Element | null,
  options: { pageCss?: string; pageSize?: string; title?: string } = {},
): Promise<BridgePrintResult> {
  if (!element) return { printed: false, reason: "The receipt is not rendered yet." };
  const settings = loadPrinterSettings();
  if (!settings.silentPrint || !settings.receiptPrinter) {
    return { printed: false, reason: "Silent receipt printing is not configured." };
  }
  const html = serializeElementForBridge(element, {
    title: options.title || "Receipt",
    pageCss: options.pageCss,
    bodyClass: "receipt-print-body",
  });
  return printHtmlViaBridge(html, {
    printer: settings.receiptPrinter,
    copies: settings.receiptCopies,
    title: options.title || "Receipt",
    pageSize: options.pageSize || "80mm auto",
    bridgeUrl: settings.bridgeUrl,
  });
}

/**
 * Prints the label root silently through the configured tag printer. The
 * caller must pass the element carrying `data-barcode-print-root` and the
 * matching `@page label` rule.
 */
export async function printLabelsViaBridge(
  element: Element | null,
  options: { pageCss: string; title?: string; copies?: number },
): Promise<BridgePrintResult> {
  if (!element) return { printed: false, reason: "No labels are queued." };
  const settings = loadPrinterSettings();
  if (!settings.silentPrint || !settings.labelPrinter) {
    return { printed: false, reason: "Silent label printing is not configured." };
  }
  const html = serializeElementForBridge(element, {
    title: options.title || "Labels",
    pageCss: options.pageCss,
    htmlClass: "direct-label-print",
    bodyClass: "labels-module",
  });
  return printHtmlViaBridge(html, {
    printer: settings.labelPrinter,
    copies: options.copies || 1,
    title: options.title || "Labels",
    bridgeUrl: settings.bridgeUrl,
  });
}
