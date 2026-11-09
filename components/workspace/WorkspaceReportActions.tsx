"use client";

import { Download, Eye, Printer, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import {
  generateCombinedTableDocument,
  type GeneratedDocument,
  type ReportMetadata,
  type ReportTableSection,
} from "@/lib/print/document";
import { printHtmlDocument } from "@/lib/print/print-window";

interface WorkspaceReportActionsProps {
  title: string;
  sections: ReportTableSection[];
  summary?: [string, string | number][];
  metadata?: ReportMetadata;
  onRefresh: () => void;
  refreshing: boolean;
  disabled?: boolean;
  inline?: boolean;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeFilename(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

export function WorkspaceReportActions({
  title,
  sections,
  summary = [],
  metadata,
  onRefresh,
  refreshing,
  disabled = false,
  inline = false,
}: WorkspaceReportActionsProps) {
  const { settings } = useBusinessSettings();
  const [preview, setPreview] = useState<GeneratedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasContent = summary.length > 0 || sections.some((section) => section.rows.length > 0);
  const unavailable = disabled || !hasContent;

  useEffect(() => {
    if (!preview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

  const buildDocument = (): GeneratedDocument => generateCombinedTableDocument({
    title,
    sections,
    summary,
    branding: {
      businessName: settings.businessName,
      businessTagline: settings.businessTagline,
      logoDataUrl: settings.logoDataUrl,
    },
    metadata: { ...metadata, printedAt: new Date() },
  });

  const exportCsv = () => {
    const lines: string[] = [];
    if (summary.length) {
      lines.push(csvCell("Summary"));
      lines.push([csvCell("Metric"), csvCell("Value")].join(","));
      for (const [label, value] of summary) lines.push([csvCell(label), csvCell(String(value))].join(","));
    }
    for (const section of sections) {
      if (!section.columns.length) continue;
      if (lines.length) lines.push("");
      lines.push(csvCell(section.title));
      lines.push(section.columns.map(csvCell).join(","));
      for (const row of section.rows) lines.push(row.map(csvCell).join(","));
    }
    if (!lines.length) return;

    const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFilename(title)}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const printDocument = (documentToPrint: GeneratedDocument) => {
    setError(null);
    if (!printHtmlDocument(documentToPrint.html, { title: documentToPrint.title })) {
      setError("The print window was blocked. Allow pop-ups for this site and try again.");
    }
  };

  return (
    <>
      <div
        className={`workspace-report-actions daily-report-no-print${inline ? " workspace-report-actions-inline" : ""}`}
        aria-label={`${title} page actions`}
      >
        <button className="button secondary" type="button" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button className="button secondary" type="button" onClick={exportCsv} disabled={unavailable}>
          <Download size={14} /> Export CSV
        </button>
        <button className="button secondary" type="button" onClick={() => printDocument(buildDocument())} disabled={unavailable}>
          <Printer size={14} /> Print A4
        </button>
        <button className="button secondary" type="button" onClick={() => {
          setError(null);
          setPreview(buildDocument());
        }} disabled={unavailable}>
          <Eye size={14} /> Preview
        </button>
        {error && <span className="table-document-error" role="alert">{error}</span>}
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="table-document-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section aria-label={`${title} report preview`} aria-modal="true" className={`table-document-preview ${preview.orientation}`} role="dialog">
            <header>
              <div>
                <h2>{title}</h2>
                <p>A4 {preview.orientation} · {sections.reduce((total, section) => total + section.rows.length, 0)} rows</p>
              </div>
              <button type="button" className="button secondary" onClick={() => setPreview(null)}>Close</button>
            </header>
            <div className="table-document-paper">
              <iframe title={`${title} preview`} srcDoc={preview.html} sandbox="" />
            </div>
            <footer>
              <span>Includes the data currently selected by this page’s filters.</span>
              <button type="button" className="button" onClick={() => printDocument(preview)}>
                <Printer size={14} /> Print / Save as PDF
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
