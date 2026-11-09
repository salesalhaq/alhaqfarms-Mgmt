"use client";

import { Download, LoaderCircle, Printer, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import {
  formatReportValue,
  reportCatalog,
  reportGroups,
  reportRowValues,
  reportSectionCsv,
  reportTotalsRow,
  type ReportCenterPayload,
  type ReportCell,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportSectionSpec,
  type ReportTableSpec,
} from "@/lib/reports/report-center";
import {
  baseDocument,
  chooseOrientation,
  escapeHtml,
  reportTableMarkup,
  type GeneratedDocument,
  type PrintOrientation,
  type ReportColumn,
} from "@/lib/print/document";
import { printHtmlDocument } from "@/lib/print/print-window";
import type { WorkspaceModule } from "@/lib/workspace-modules";

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(1);
  return [localDateKey(from), localDateKey(to)];
}

function safeFilename(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

function numericType(type: ReportColumnSpec["type"]): boolean {
  return type === "money" || type === "int" || type === "num" || type === "pct";
}

function printColumns(columns: ReportColumnSpec[]): ReportColumn[] {
  return columns.map((column) => ({
    label: column.label,
    weight: numericType(column.type) ? 1 : 2,
    priority: 1,
    long: column.type === "text" && /customer|description|reason|note|product|vendor|employee|reference/i.test(column.label),
    numeric: numericType(column.type),
  }));
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(anchor.href);
}

function tableTotals(table: ReportTableSpec): string[] | null {
  if (!table.totals) return null;
  return reportTotalsRow(table).map((value, index) => (index === 0 && !value ? "Total" : value));
}

function sectionContent(section: ReportSectionSpec): string {
  return section.tables.map((table) => {
    const columns = printColumns(table.columns);
    const rows = table.rows.map((row) => reportRowValues(table, row));
    const heading = table.title ? `<h3 class="rc-print-sub">${escapeHtml(table.title)}</h3>` : "";
    return `${heading}${reportTableMarkup(columns, rows, {
      emptyMessage: table.empty || "No records for this period.",
      totals: tableTotals(table),
    })}`;
  }).join("");
}

function ReportTable({ table }: { table: ReportTableSpec }) {
  const totals = tableTotals(table);
  return (
    <div className="report-center-table-block">
      {table.title && <h3 className="report-center-subtitle">{table.title}</h3>}
      <div className="table-wrap">
        <table className="workspace-table">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column.key} className={numericType(column.type) ? "numeric" : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length ? table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.columns.map((column) => (
                  <td key={column.key} className={numericType(column.type) ? "numeric" : undefined}>
                    {formatReportValue(row[column.key] as ReportCell, column.type)}
                  </td>
                ))}
              </tr>
            )) : (
              <tr>
                <td colSpan={table.columns.length} className="empty">
                  {table.empty || "No records for this period."}
                </td>
              </tr>
            )}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                {totals.map((value, index) => (
                  <td key={table.columns[index]?.key || index} className={numericType(table.columns[index]?.type || "text") ? "numeric" : undefined}>
                    {value}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export function ReportCenterWorkspace({
  item,
  kind,
}: {
  item: WorkspaceModule;
  kind?: "admin" | "erp";
}) {
  const reportKind = kind ?? (item.slug === "erp-reports" ? "erp" : "admin");
  const catalog = useMemo<ReportDefinition[]>(
    () => reportCatalog(reportKind),
    [reportKind],
  );
  const groups = useMemo(() => reportGroups(catalog), [catalog]);
  const { staff, branches } = useStaffAuth();
  const { settings: businessSettings } = useBusinessSettings();
  const [[defaultFrom, defaultTo]] = useState(defaultDateRange);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [branchId, setBranchId] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(catalog.map((report) => report.id)));
  const [activeGroup, setActiveGroup] = useState(groups[0]?.name || "");
  const [newPageEach, setNewPageEach] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const [payload, setPayload] = useState<ReportCenterPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setSelected(new Set(catalog.map((report) => report.id)));
    setActiveGroup(groups[0]?.name || "");
  }, [catalog, groups]);

  useEffect(() => {
    if (!staff) return;
    if (staff.role !== "admin" && staff.branch_id && branchId === "all") {
      setBranchId(staff.branch_id);
    }
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams({ from: fromDate, to: toDate });
    if (branchId) parameters.set("branchId", branchId);
    const endpoint = reportKind === "erp" ? "/api/workspace/erp-report-center" : "/api/workspace/report-center";

    void (async () => {
      try {
        const response = await fetch(`${endpoint}?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as ReportCenterPayload & { error?: string };
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the report data.");
        setPayload(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the report data.");
        setPayload(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, fromDate, reloadKey, reportKind, staff, toDate]);

  const sections = useMemo(
    () => payload?.sections || [],
    [payload],
  );
  const selectedSections = useMemo(
    () => sections.filter((section) => selected.has(section.id)),
    [sections, selected],
  );
  const currentGroup = groups.find((group) => group.name === activeGroup) || groups[0];
  const groupSelected = currentGroup
    ? currentGroup.items.filter((report) => selected.has(report.id)).length
    : 0;

  const applyPreset = (days: number | "month") => {
    const end = new Date();
    const start = new Date(end);
    if (days === "month") start.setDate(1);
    else start.setDate(start.getDate() - days + 1);
    setFromDate(localDateKey(start));
    setToDate(localDateKey(end));
  };

  const toggleReport = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (groupName: string) => {
    const group = groups.find((entry) => entry.name === groupName);
    if (!group) return;
    const allSelected = group.items.every((report) => selected.has(report.id));
    setSelected((current) => {
      const next = new Set(current);
      for (const report of group.items) {
        if (allSelected) next.delete(report.id);
        else next.add(report.id);
      }
      return next;
    });
  };

  const buildDocument = (
    targetSections: ReportSectionSpec[],
    options: { title: string; newPageEach: boolean; landscape: boolean },
  ): GeneratedDocument | null => {
    if (!targetSections.length) return null;
    const allColumns = targetSections.flatMap((section) =>
      section.tables.flatMap((table) => printColumns(table.columns)));
    const orientation: PrintOrientation = options.landscape ? "landscape" : "auto";
    const resolvedOrientation = chooseOrientation(allColumns, orientation);
    const content = [
      `<style>.rc-print-sub{margin:3mm 0 1mm;font-size:9pt;font-weight:700;color:#333}.rc-print-note{margin:0 0 2mm;font-size:8pt;color:#555}</style>`,
      ...targetSections.map((section, index) => {
        const pageBreak = options.newPageEach && index > 0
          ? ' style="break-before:page;page-break-before:always"'
          : "";
        const note = section.note ? `<p class="rc-print-note">${escapeHtml(section.note)}</p>` : "";
        return `<section class="report-section"${pageBreak}><h2>${escapeHtml(section.title)}</h2>${note}${sectionContent(section)}</section>`;
      }),
    ].join("");
    return {
      title: options.title,
      orientation: resolvedOrientation,
      html: baseDocument({
        reportTitle: options.title,
        orientation: resolvedOrientation,
        branding: {
          businessName: businessSettings.businessName,
          businessTagline: businessSettings.businessTagline,
          logoDataUrl: businessSettings.logoDataUrl,
        },
        metadata: {
          printedAt: new Date(),
          printedBy: staff?.full_name || "Staff",
          branch: payload?.branchName || (branchId === "all" ? "All accessible branches" : branches.find((branch) => branch.id === branchId)?.name || "Your branch"),
          period: `${fromDate} to ${toDate}`,
          filterSummary: `${targetSections.length} report${targetSections.length === 1 ? "" : "s"}`,
        },
        content,
      }),
    };
  };

  const printSections = (targetSections: ReportSectionSpec[], title: string, pageEach = newPageEach) => {
    const document = buildDocument(targetSections, {
      title,
      newPageEach: pageEach,
      landscape,
    });
    if (!document) {
      setError("Select at least one report to print.");
      return;
    }
    if (!printHtmlDocument(document.html, { title: document.title })) {
      setError("The print window was blocked. Allow pop-ups for this site and try again.");
    }
  };

  const exportSection = (section: ReportSectionSpec) => {
    const csv = reportSectionCsv(section);
    if (!csv.trim()) {
      setError("This report has no table data to export.");
      return;
    }
    downloadCsv(`${reportKind}-${safeFilename(section.id)}-${fromDate}_to_${toDate}.csv`, csv);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>
            {item.description} Pick the reports you need, set the dates and branch, then print them together or one by one, or download each as CSV.
          </p>
        </div>
      </div>

      <HorizontalFilterScroller
        className="daily-report-toolbar report-center-filterbar daily-report-no-print"
        ariaLabel="Report center filters and date ranges"
      >
        {staff?.role === "admin" && (
          <label className="toolbar-control">
            <span>Branch</span>
            <SearchableFilter
              value={branchId || "all"}
              ariaLabel="Filter reports by branch"
              placeholder="All accessible branches"
              options={[
                { value: "all", label: "All accessible branches" },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              onChange={setBranchId}
            />
          </label>
        )}
        <label className="toolbar-control report-center-date">
          <span>From</span>
          <input type="date" value={fromDate} max={toDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="toolbar-control report-center-date">
          <span>To</span>
          <input type="date" value={toDate} min={fromDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <div className="heading-actions report-center-date-presets" role="group" aria-label="Quick date ranges">
          <button className="button secondary" type="button" onClick={() => applyPreset(7)}>7 days</button>
          <button className="button secondary" type="button" onClick={() => applyPreset(30)}>30 days</button>
          <button className="button secondary" type="button" onClick={() => applyPreset("month")}>This month</button>
        </div>
        <div className="heading-actions report-center-filter-actions">
          <button
            className="button"
            type="button"
            onClick={() => printSections(selectedSections, `${reportKind === "erp" ? "ERP" : "Admin"} report center`)}
            disabled={!selectedSections.length || loading}
          >
            <Printer size={15} /> Print selected reports
          </button>
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
          </button>
        </div>
      </HorizontalFilterScroller>

      {error && <div className="notice" role="alert">{error}</div>}

      <section className="card panel" aria-label="Report picker">
        <div className="section-heading">
          <div>
            <p className="eyebrow page">Report picker</p>
            <h2>{selected.size}/{catalog.length} selected</h2>
          </div>
        </div>

        <HorizontalFilterScroller className="report-center-tab-row" ariaLabel="Report groups and print options">
          <div className="report-center-group-tabs" role="tablist" aria-label="Report groups">
            {groups.map((group) => (
              <button
                key={group.name}
                type="button"
                role="tab"
                aria-selected={activeGroup === group.name}
                className={`button secondary${activeGroup === group.name ? " is-active" : ""}`}
                onClick={() => setActiveGroup(group.name)}
              >
                {group.name}
                <small>{group.items.filter((report) => selected.has(report.id)).length}/{group.items.length}</small>
              </button>
            ))}
          </div>
          <div className="heading-actions report-center-picker-actions">
            <button className="button secondary" type="button" onClick={() => setSelected(new Set(catalog.map((report) => report.id)))}>Select all</button>
            <button className="button secondary" type="button" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
          <div className="report-center-print-options">
            <label className="report-center-check">
              <input type="checkbox" checked={newPageEach} onChange={(event) => setNewPageEach(event.target.checked)} />
              New page each
            </label>
            <label className="report-center-check">
              <input type="checkbox" checked={landscape} onChange={(event) => setLandscape(event.target.checked)} />
              Landscape
            </label>
          </div>
        </HorizontalFilterScroller>

        <HorizontalFilterScroller className="report-center-picker-scroller" ariaLabel="Report picker options">
          <div className="report-center-picker-options">
            <label className="report-center-option card">
              <input
                type="checkbox"
                checked={Boolean(currentGroup) && groupSelected === currentGroup.items.length}
                onChange={() => currentGroup && toggleGroup(currentGroup.name)}
              />
              <span><strong>All {currentGroup?.name}</strong><small>Select or clear every report in this group.</small></span>
            </label>
            {currentGroup?.items.map((report) => (
              <label className="report-center-option card" key={report.id}>
                <input
                  type="checkbox"
                  checked={selected.has(report.id)}
                  onChange={() => toggleReport(report.id)}
                />
                <span><strong>{report.icon} {report.title}</strong><small>{report.group}</small></span>
              </label>
            ))}
          </div>
        </HorizontalFilterScroller>
      </section>

      {loading && !payload && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading reports…</div>}

      {payload && !selectedSections.length && (
        <div className="notice" role="status">Select at least one report to view, print, or export.</div>
      )}

      {selectedSections.map((section) => (
        <section className="card panel report-center-section" key={section.id}>
          <div className="section-heading">
            <div>
              <p className="eyebrow page">{section.group}</p>
              <h2>{catalog.find((report) => report.id === section.id)?.icon} {section.title}</h2>
            </div>
            <div className="heading-actions">
              <button className="button secondary" type="button" onClick={() => printSections([section], section.title, false)}>
                <Printer size={14} /> Print
              </button>
              <button className="button secondary" type="button" onClick={() => exportSection(section)}>
                <Download size={14} /> CSV
              </button>
            </div>
          </div>
          {section.note && <p className="muted report-center-note">{section.note}</p>}
          {section.tables.map((table, index) => (
            <ReportTable key={`${section.id}-${index}`} table={table} />
          ))}
        </section>
      ))}

      <p className="list-limit-note">
        Reports are read-only and follow your signed-in branch access. Reports marked &quot;as of today&quot; (stock, balances, receivables) always show the current position.
      </p>
    </>
  );
}

export default ReportCenterWorkspace;
