/**
 * Print document generators.
 *
 * The A4 report layout, CSS and formatting rules are ported from the Windows
 * desktop app (`electron/report-documents.cjs`) so the web app produces the
 * same document as the offline client. Keep this file in sync with that source.
 */

import { DEFAULT_BRAND_NAME, DEFAULT_BRAND_TAGLINE } from "@/lib/branding";

export type PrintOrientation = "auto" | "portrait" | "landscape";
export type ResolvedOrientation = Exclude<PrintOrientation, "auto">;

export interface ReportBranding {
  businessName?: string;
  businessTagline?: string;
  logoDataUrl?: string;
}

export interface ReportMetadata {
  printedAt?: string | Date | null;
  printedBy?: string | null;
  branch?: string | null;
  period?: string | null;
  filterSummary?: string | null;
  tightColumns?: boolean;
}

export interface ReportColumn {
  label: string;
  weight: number;
  priority?: 1 | 2;
  long?: boolean;
  numeric?: boolean;
}

export interface TableReportInput {
  title: string;
  columns: string[];
  rows: string[][];
  branding?: ReportBranding;
  metadata?: ReportMetadata;
  orientation?: PrintOrientation;
}

export interface GeneratedDocument {
  html: string;
  orientation: ResolvedOrientation;
  title: string;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssString(value: unknown): string {
  return `"${String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, " ")}"`;
}

/** Desktop parity: `Rs 1,234.50` (paisa input). */
export function formatReportMoney(paisa: number | null | undefined): string {
  const amount = Number(paisa || 0);
  if (!Number.isFinite(amount)) return "Rs 0.00";
  return `Rs ${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount / 100)}`;
}

/** Desktop parity: three decimal places (milli input). */
export function formatReportQuantity(milli: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(Number(milli || 0) / 1000);
}

export function formatReportPercent(value: number | null | undefined): string {
  return `${Number(value || 0).toFixed(1)}%`;
}

export function formatReportDate(
  value: string | Date | null | undefined,
  { withTime = false }: { withTime?: boolean } = {},
): string {
  if (!value) return "—";
  const source = value instanceof Date ? value : String(value);
  if (!withTime && typeof source === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const [year, month, day] = source.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(year, month - 1, day));
  }
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.getTime())) return String(source);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: true } : {}),
  }).format(date);
}

export function safeLogoDataUrl(value: string | null | undefined): string {
  const logo = String(value || "");
  if (logo.length > MAX_LOGO_BYTES * 1.4) return "";
  if (/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(logo)) return logo;
  if (logo === "/brand-mark.png") return logo;
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/brand-mark\.png$/.test(logo)
    ? logo
    : "";
}

function defaultBrandLogoUrl(): string {
  return typeof window === "undefined"
    ? "/brand-mark.png"
    : new URL("/brand-mark.png", window.location.origin).href;
}

export function chooseOrientation(
  columns: ReportColumn[],
  preference: PrintOrientation = "auto",
): ResolvedOrientation {
  if (!["auto", "portrait", "landscape"].includes(preference)) {
    throw new Error("Choose Auto, Portrait or Landscape for report orientation.");
  }
  if (preference !== "auto") return preference;
  const weights = columns.reduce((total, column) => total + column.weight, 0);
  const hasLongField = columns.some((column) => column.long);
  return columns.length >= 8 || hasLongField || weights * 12 > 186
    ? "landscape"
    : "portrait";
}

function svgDataUrl(svg: string): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

function compactHeaderImage(businessName: string, logoDataUrl?: string): string {
  const logo = safeLogoDataUrl(logoDataUrl);
  const company = String(businessName || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const logoMarkup = logo
    ? `<image href="${logo}" x="0" y="1" width="36" height="28" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  const textX = logo ? 44 : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="30" viewBox="0 0 260 30">${logoMarkup}<text x="${textX}" y="19" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="700">${company}</text></svg>`;
  return svgDataUrl(svg);
}

function columnMarkup(columns: ReportColumn[]): string {
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0) || 1;
  const widths = columns.map((column) => `${(column.weight / totalWeight) * 100}%`);
  const colgroup = `<colgroup>${widths.map((width) => `<col style="width:${width}">`).join("")}</colgroup>`;
  const header = `<thead><tr>${columns
    .map(
      (column) =>
        `<th class="${column.numeric ? "numeric" : ""} ${column.priority === 2 ? "optional-column" : ""}">${escapeHtml(column.label)}</th>`,
    )
    .join("")}</tr></thead>`;
  return `${colgroup}${header}`;
}

export function reportTableMarkup(
  columns: ReportColumn[],
  rows: string[][],
  { emptyMessage = "No records for this period", totals = null }: {
    emptyMessage?: string;
    totals?: (string | number)[] | null;
  } = {},
): string {
  if (!columns.length) return "";
  const tableHeader = columnMarkup(columns);
  const body = rows.length
    ? rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, index) => {
                const column = columns[index] || {};
                return `<td class="${column.numeric ? "numeric" : ""} ${column.priority === 2 ? "optional-column" : ""}">${escapeHtml(cell)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")
    : `<tr><td class="empty-row" colspan="${columns.length}">${escapeHtml(emptyMessage)}</td></tr>`;
  const totalsRow = totals
    ? `<tfoot><tr>${totals
        .map(
          (cell, index) =>
            `<td class="${columns[index]?.numeric ? "numeric" : ""}">${escapeHtml(cell)}</td>`,
        )
        .join("")}</tr></tfoot>`
    : "";
  return `<table class="report-table">${tableHeader}<tbody>${body}</tbody>${totalsRow}</table>`;
}

export function summaryMarkup(rows: [string, string | number][]): string {
  return `<div class="summary">${rows
    .map(
      ([label, value]) =>
        `<div class="summary-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join("")}</div>`;
}

export function sectionMarkup(title: string, content: string): string {
  return `<section class="report-section"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function reportStyles(
  orientation: ResolvedOrientation,
  businessName: string,
  reportTitle: string,
  logoDataUrl?: string,
): string {
  const pageSize = orientation === "landscape" ? "A4 landscape" : "A4 portrait";
  const compactBrand = compactHeaderImage(businessName, logoDataUrl);
  return `
    @page {
      size: ${pageSize};
      margin: 16mm 12mm 18mm;
      @top-left {
        content: ${compactBrand};
      }
      @top-center {
        content: ${cssString(reportTitle)};
        color: #111;
        font: 7.5pt Arial, Helvetica, sans-serif;
        font-weight: 700;
      }
      @top-right {
        content: "Page " counter(page) " of " counter(pages);
        color: #333;
        font: 7.5pt Arial, Helvetica, sans-serif;
      }
      @bottom-right {
        content: "Page " counter(page) " of " counter(pages);
        color: #333;
        font: 7.5pt Arial, Helvetica, sans-serif;
        border-top: 1px dashed #777;
        padding-top: 2mm;
      }
      @bottom-left {
        content: "Thank You!  " ${cssString(businessName)} "  This is a computer generated report";
        color: #333;
        font: 7.5pt Arial, Helvetica, sans-serif;
        border-top: 1px dashed #777;
        padding-top: 2mm;
      }
    }
    @page:first {
      @top-left { content: none; }
      @top-center { content: none; }
      @top-right { content: none; }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; }
    body { font: 9pt Arial, Helvetica, sans-serif; line-height: 1.3; }
    .report-page { width: 100%; background: #fff; }
    .report-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(62mm, auto); gap: 5mm; align-items: center; padding-bottom: 4mm; border-bottom: 1px dashed #555; }
    .brand-block { display: flex; align-items: center; gap: 4mm; min-width: 0; }
    .brand-logo { width: 24mm; height: 24mm; object-fit: contain; flex: 0 0 auto; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .brand-copy { min-width: 0; overflow-wrap: break-word; }
    .brand-copy strong { display: block; font-size: 13pt; line-height: 1.15; font-weight: 700; }
    .brand-copy em { display: block; margin-top: 1mm; color: #333; font-size: 8.5pt; }
    .report-context { display: grid; grid-template-columns: auto minmax(0, auto); gap: 1mm 3mm; justify-content: end; max-width: 95mm; font-size: 8.5pt; }
    .report-context span { color: #666; white-space: nowrap; }
    .report-context strong { min-width: 0; text-align: right; overflow-wrap: anywhere; font-weight: 600; }
    .report-title { margin: 4mm 0 2mm; text-align: center; font-size: 14pt; letter-spacing: .3pt; }
    .separator { border: 0; border-top: 1px dashed #555; margin: 2mm 0 3mm; }
    .summary { border-bottom: 1px dashed #555; padding: 1mm 0 3mm; margin-bottom: 3mm; }
    .summary-row { display: flex; justify-content: space-between; gap: 8mm; padding: 1mm 0; }
    .summary-row span { color: #555; }
    .summary-row strong { text-align: right; font-weight: 700; }
    .summary-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm 12mm; }
    .report-section { margin: 4mm 0 5mm; break-inside: avoid; page-break-inside: avoid; }
    .report-section h2 { margin: 0 0 1.5mm; font-size: 10pt; font-weight: 700; }
    .report-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5pt; }
    .report-table thead { display: table-header-group; }
    .report-table tfoot { display: table-row-group; }
    .report-table tr { break-inside: avoid; page-break-inside: avoid; }
    .report-table th { padding: 1.8mm 1.2mm; border-top: 1px dashed #555; border-bottom: 1px dashed #555; text-align: left; vertical-align: bottom; font-weight: 700; overflow-wrap: break-word; hyphens: none; }
    .report-table td { padding: 1.5mm 1.2mm; border-bottom: 1px dashed #ccc; vertical-align: top; overflow-wrap: break-word; word-break: normal; }
    .report-table .numeric { text-align: right; white-space: nowrap; }
    .report-table tfoot td { border-top: 1px solid #555; border-bottom: 1px dashed #555; font-weight: 700; }
    .report-table .empty-row { padding: 4mm 1mm; text-align: center; color: #444; }
    .report-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 6mm; padding-top: 2mm; border-top: 1px dashed #777; background: #fff; font-size: 7.5pt; }
    .optional-column { }
    .tight-columns .report-table { font-size: 8pt; }
    .tight-columns .report-table td, .tight-columns .report-table th { overflow-wrap: anywhere; white-space: normal; }
    .tight-columns .optional-column { display: none; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .report-section { break-inside: auto; page-break-inside: auto; }
      .report-table { font-size: 8.5pt; }
      .report-footer { display: none; }
    }
    @media screen {
      body { padding: 12mm; }
    }
  `;
}

function pageHeader({
  reportTitle,
  businessName,
  businessTagline,
  logoDataUrl,
  printedAt,
  printedBy,
  branch,
  period,
  filterSummary,
}: ReportMetadata & ReportBranding & { reportTitle: string }): string {
  const logo = safeLogoDataUrl(logoDataUrl);
  const brandName = String(businessName || DEFAULT_BRAND_NAME).trim();
  const brandTagline = String(businessTagline || DEFAULT_BRAND_TAGLINE).trim();
  const brandCopy = `${brandName ? `<strong>${escapeHtml(brandName)}</strong>` : ""}${brandTagline ? `<em>${escapeHtml(brandTagline)}</em>` : ""}`;
  const context: [string, string][] = [
    ["Printed at", formatReportDate(printedAt || new Date(), { withTime: true })],
    ["Printed by", printedBy || "Staff"],
    ["Branch", branch || "All branches"],
    ...(period ? [["Period", period] as [string, string]] : []),
    ...(filterSummary ? [["Filters", filterSummary] as [string, string]] : []),
  ];
  return `<header class="report-header">
    <div class="brand-block">${logo ? `<img class="brand-logo" src="${logo}" alt="">` : ""}
      <div class="brand-copy">${brandCopy}</div>
    </div>
    <div class="report-context">${context
      .map(([label, value]) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`)
      .join("")}</div>
  </header>
  <h1 class="report-title">${escapeHtml(reportTitle)}</h1>
  <hr class="separator">`;
}

function baseDocument({
  reportTitle,
  orientation,
  branding,
  metadata,
  content,
}: {
  reportTitle: string;
  orientation: ResolvedOrientation;
  branding: ReportBranding;
  metadata: ReportMetadata;
  content: string;
}): string {
  const reportName = escapeHtml(reportTitle);
  const resolvedBusinessName = branding.businessName || DEFAULT_BRAND_NAME;
  const logoUrl = safeLogoDataUrl(branding.logoDataUrl) || defaultBrandLogoUrl();
  const resolvedBranding: ReportBranding = {
    businessName: resolvedBusinessName,
    businessTagline: branding.businessTagline || DEFAULT_BRAND_TAGLINE,
    logoDataUrl: logoUrl,
  };
  const businessName = escapeHtml(resolvedBusinessName);
  const logoOrigin = logoUrl.startsWith("data:")
    ? "'self'"
    : new URL(logoUrl, typeof window === "undefined" ? "https://localhost" : window.location.origin).origin;
  const bodyContent = metadata.tightColumns
    ? `<div class="tight-columns">${content}</div>`
    : content;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${reportName}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${escapeHtml(logoOrigin)}; style-src 'unsafe-inline'; font-src 'self' data:">
<style>${reportStyles(orientation, resolvedBusinessName, reportTitle, logoUrl)}</style></head>
<body><main class="report-page">
${pageHeader({ ...metadata, reportTitle, ...resolvedBranding })}
${bodyContent}
</main><footer class="report-footer"><span>Thank You!</span><strong>${businessName}</strong><span>This is a computer generated report</span></footer></body></html>`;
}

/** Desktop-style column weights for an arbitrary table snapshot. */
export function tableColumns(labels: string[]): ReportColumn[] {
  return labels.map((label) => ({
    label,
    weight: /email|reason|customer|description|reference/i.test(label) ? 2 : 1,
    priority: 1,
    long: /email|reason|order/i.test(label),
    numeric: /^(count|qty|quantity|total|amount|price|cost|value)$/i.test(label),
  }));
}

/**
 * Generic table report used by `TableDocumentTools`. Mirrors the desktop
 * `tableReportHtml` generator (summary + section + table).
 */
export function generateTableDocument(input: TableReportInput): GeneratedDocument {
  const title = String(input.title || "TABLE REPORT").toUpperCase();
  const columns = tableColumns(input.columns);
  const orientation = chooseOrientation(columns, input.orientation || "auto");
  const branding: ReportBranding = input.branding || {};
  const content = `${summaryMarkup([["Records", input.rows.length]])}
  ${sectionMarkup(input.title, reportTableMarkup(columns, input.rows))}`;
  return {
    html: baseDocument({
      reportTitle: title,
      orientation,
      branding,
      metadata: input.metadata || {},
      content,
    }),
    orientation,
    title,
  };
}

export { reportStyles, baseDocument, pageHeader };
