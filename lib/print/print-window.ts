/**
 * Opens generated print documents in a dedicated window and prints them.
 *
 * Printing from the opener window (instead of an inline script) keeps the
 * generated document CSP strict and avoids depending on `javascript:` in the
 * print window.
 */

export interface PrintWindowOptions {
  /** Print as soon as the document finishes loading. Defaults to true. */
  autoPrint?: boolean;
  /** Title used for the browser print job / PDF filename. */
  title?: string;
}

function writeWindow(win: Window, html: string, title?: string) {
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (title) {
    try {
      win.document.title = title;
    } catch {
      // Some browsers lock the title until the document loads.
    }
  }
}

function afterLoad(win: Window, callback: () => void) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    callback();
  };
  try {
    if (win.document.readyState === "complete") {
      window.setTimeout(run, 120);
      return;
    }
  } catch {
    // Fall through to the load listener.
  }
  win.addEventListener("load", () => window.setTimeout(run, 120), { once: true });
  // Safety net for documents that never fire `load` (e.g. blocked images).
  window.setTimeout(run, 1500);
}

/**
 * Opens a print document and triggers the browser print dialog.
 * Returns false when the pop-up was blocked.
 */
export function printHtmlDocument(html: string, options: PrintWindowOptions = {}): boolean {
  // Do not pass `noopener` in the feature string: some browsers then return
  // `null` and the caller cannot write the document. We null `opener` below.
  const win = window.open("", "_blank");
  if (!win) return false;
  try {
    win.opener = null;
  } catch {
    // Ignore: some browsers expose a read-only opener.
  }
  writeWindow(win, html, options.title);
  afterLoad(win, () => {
    try {
      win.focus();
      if (options.autoPrint !== false) win.print();
    } catch {
      // The user can still print manually from the opened window.
    }
  });
  return true;
}

/**
 * Opens a print document without printing, for an in-app/new-tab preview.
 * Returns false when the pop-up was blocked.
 */
export function openHtmlDocument(html: string, options: PrintWindowOptions = {}): boolean {
  return printHtmlDocument(html, { ...options, autoPrint: false });
}

/** Trigger the browser print dialog for the current page (receipts, labels). */
export function printCurrentPage() {
  window.print();
}

/**
 * Waits until every on-screen receipt QR has finished rendering (desktop waits
 * for the same `data-ready` marker before printing). Resolves after the timeout
 * even if a QR failed, so printing is never blocked forever.
 */
export function waitForReceiptQr(timeoutMs = 2500): Promise<void> {
  const nodes = [...document.querySelectorAll<HTMLElement>('.receipt-qr[data-ready="false"]')];
  if (!nodes.length) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (
        nodes.every(
          (node) =>
            node.getAttribute("data-ready") === "true" || node.getAttribute("data-error"),
        )
      ) {
        finish();
      }
    });
    for (const node of nodes) {
      observer.observe(node, { attributes: true, attributeFilter: ["data-ready", "data-error"] });
    }
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

