"use client";

import { ChevronDown, Download, Eye, FileDown, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import {
  generateTableDocument,
  type GeneratedDocument,
  type PrintOrientation,
} from "@/lib/print/document";
import { printHtmlDocument } from "@/lib/print/print-window";
import { loadPrinterSettings } from "@/lib/print/printer-settings";
import { printHtmlViaBridge } from "@/lib/print/bridge-print";

type DocumentAction = "print" | "preview" | "csv" | "pdf";
interface TableSnapshot {
  columns: string[];
  rows: string[][];
}

const ORIENTATIONS: PrintOrientation[] = ["auto", "portrait", "landscape"];

function readOrientation(key: string): PrintOrientation {
  try {
    const saved = window.localStorage.getItem(`alhaq.report-orientation.${key}`);
    return ORIENTATIONS.includes(saved as PrintOrientation)
      ? (saved as PrintOrientation)
      : "auto";
  } catch {
    return "auto";
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function safeFilename(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "table"
  );
}

function readTable(tableId: string): TableSnapshot | null {
  const table = document.getElementById(tableId);
  if (!(table instanceof HTMLTableElement)) return null;
  const headerCells = [...(table.tHead?.rows[0]?.cells || [])];
  if (!headerCells.length) return null;

  const excludedColumns = headerCells
    .map((cell, index) =>
      /^(actions?|details?|view)$/i.test(cell.innerText.trim()) || !cell.innerText.trim()
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const columns = headerCells
    .filter((_, index) => !excludedColumns.includes(index))
    .map((cell) => cell.innerText.trim());
  const rows = [...table.tBodies]
    .flatMap((body) => [...body.rows])
    .filter((row) => !row.hidden && !row.querySelector(".empty"))
    .filter((row) => row.cells.length === headerCells.length)
    .map((row) =>
      [...row.cells]
        .filter((_, index) => !excludedColumns.includes(index))
        .map((cell) => cell.innerText.trim()),
    );
  return { columns, rows };
}

export function TableDocumentTools({
  tableId,
  title,
  disabled = false,
  orientationKey,
  buildDocument,
}: {
  tableId: string;
  title: string;
  disabled?: boolean;
  /** Stable key for the saved orientation. Defaults to the table id. */
  orientationKey?: string;
  /**
   * Optional desktop-specific document builder. When provided, print/preview
   * use this document instead of the generic table snapshot (CSV still exports
   * the visible table). Returning null means the report is not ready.
   */
  buildDocument?: (orientation: PrintOrientation) => GeneratedDocument | null;
}) {
  const { settings: businessSettings } = useBusinessSettings();
  const [orientation, setOrientation] = useState<PrintOrientation>("auto");
  const [openMenu, setOpenMenu] = useState<"print" | "export" | null>(null);
  const [preview, setPreview] = useState<
    (GeneratedDocument & { rowCount: number }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const key = orientationKey || tableId;

  useEffect(() => setOrientation(readOrientation(key)), [key]);

  useEffect(() => {
    if (!openMenu) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!preview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

  const snapshot = () => {
    const value = readTable(tableId);
    if (!value) {
      setError("This table is not ready to export.");
      return null;
    }
    setError(null);
    return value;
  };

  const buildTableDocument = (data: TableSnapshot): GeneratedDocument =>
    generateTableDocument({
      title,
      columns: data.columns,
      rows: data.rows,
      orientation,
      branding: {
        businessName: businessSettings.businessName,
        businessTagline: businessSettings.businessTagline,
        logoDataUrl: businessSettings.logoDataUrl,
      },
      metadata: {
        printedAt: new Date(),
        printedBy: "Staff",
      },
    });

  const runAction = (action: DocumentAction) => {
    setOpenMenu(null);
    if (disabled) return;

    if (action === "csv") {
      const data = snapshot();
      if (!data) return;
      const csv = [data.columns, ...data.rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeFilename(title)}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      return;
    }

    const data = readTable(tableId);
    const generated = buildDocument
      ? buildDocument(orientation)
      : data
        ? buildTableDocument(data)
        : null;
    if (!generated) {
      setError("This report is not ready to print.");
      return;
    }
    setError(null);
    if (action === "preview") {
      setPreview({ ...generated, rowCount: data?.rows.length ?? 0 });
      return;
    }

    void printGenerated(generated);
  };

  const printGenerated = async (generated: GeneratedDocument): Promise<boolean> => {
    const settings = loadPrinterSettings();
    if (settings.silentPrint && settings.reportPrinter) {
      const result = await printHtmlViaBridge(generated.html, {
        printer: settings.reportPrinter,
        copies: 1,
        title: generated.title,
        pageSize: generated.orientation === "landscape" ? "A4 landscape" : "A4 portrait",
      });
      if (result.printed) return true;
      if (!result.bridgeUnavailable && result.reason) {
        setError(result.reason);
        return false;
      }
    }
    // Print and PDF both use the browser print dialog. Chrome's "Save as PDF"
    // produces the PDF with the same layout as the desktop report document.
    if (!printHtmlDocument(generated.html, { title: generated.title })) {
      setError("The print window was blocked. Allow pop-ups for this site and try again.");
      return false;
    }
    return true;
  };

  const updateOrientation = (value: string) => {
    const next = value as PrintOrientation;
    setOrientation(next);
    try {
      window.localStorage.setItem(`alhaq.report-orientation.${key}`, next);
    } catch {
      setError("Could not save this page orientation preference.");
    }
    setPreview(null);
  };

  return (
    <>
      <div className="table-document-tools" ref={containerRef}>
        <select
          aria-label={`${title} page orientation`}
          title="Page orientation"
          value={orientation}
          disabled={disabled}
          onChange={(event) => updateOrientation(event.target.value)}
        >
          <option value="auto">AUTO</option>
          <option value="portrait">PORT</option>
          <option value="landscape">LAND</option>
        </select>
        <div className="table-document-menu-wrap">
          <button
            type="button"
            className="button secondary table-document-button"
            aria-label={`${title} print options`}
            aria-haspopup="menu"
            aria-expanded={openMenu === "print"}
            disabled={disabled}
            onClick={() => setOpenMenu((value) => (value === "print" ? null : "print"))}
          >
            <Printer size={13} /> PRT <ChevronDown size={11} />
          </button>
          {openMenu === "print" && (
            <div className="table-document-menu" role="menu" aria-label={`${title} print options`}>
              <button type="button" role="menuitem" disabled={disabled} onClick={() => runAction("print")}>
                <Printer size={13} /> Print
              </button>
              <button type="button" role="menuitem" disabled={disabled} onClick={() => runAction("preview")}>
                <Eye size={13} /> Preview
              </button>
            </div>
          )}
        </div>
        <div className="table-document-menu-wrap">
          <button
            type="button"
            className="button secondary table-document-button"
            aria-label={`${title} export options`}
            aria-haspopup="menu"
            aria-expanded={openMenu === "export"}
            disabled={disabled}
            onClick={() => setOpenMenu((value) => (value === "export" ? null : "export"))}
          >
            <Download size={13} /> EXP <ChevronDown size={11} />
          </button>
          {openMenu === "export" && (
            <div className="table-document-menu" role="menu" aria-label={`${title} export options`}>
              <button type="button" role="menuitem" disabled={disabled} onClick={() => runAction("csv")}>
                <Download size={13} /> CSV
              </button>
              <button type="button" role="menuitem" disabled={disabled} onClick={() => runAction("pdf")}>
                <FileDown size={13} /> PDF
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <span className="table-document-error" role="alert">
          {error}
        </span>
      )}
      {preview && (
        <div
          className="table-document-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section
            aria-label={`${title} print preview`}
            aria-modal="true"
            className={`table-document-preview ${preview.orientation}`}
            role="dialog"
          >
            <header>
              <div>
                <h2>{title}</h2>
                <p>
                  A4 {preview.orientation} · {preview.rowCount} rows
                </p>
              </div>
              <button type="button" className="button secondary" onClick={() => setPreview(null)}>
                Close
              </button>
            </header>
            <div className="table-document-paper">
              <iframe title={`${title} preview`} srcDoc={preview.html} sandbox="" />
            </div>
            <footer>
              <span>
                Includes rows currently shown in this table (the current page for paginated
                lists). PDF opens the browser print dialog; choose “Save as PDF”.
              </span>
              <button
                type="button"
                className="button"
                onClick={() => {
                  void (async () => {
                    if (await printGenerated(preview)) setPreview(null);
                  })();
                }}
              >
                <Printer size={14} /> Print / Save as PDF
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
