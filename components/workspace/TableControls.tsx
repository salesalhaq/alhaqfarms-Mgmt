"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";

interface TableColumnFilter {
  column: string;
  label?: string;
}

const EMPTY_COLUMN_FILTERS: TableColumnFilter[] = [];

export function TableControls({
  tableId,
  ariaLabel,
  filterColumns: requestedFilters,
  searchPlaceholder = "Search this table",
  includeSearch = true,
  onFilterChange,
}: {
  tableId: string;
  ariaLabel: string;
  filterColumns?: TableColumnFilter[];
  searchPlaceholder?: string;
  includeSearch?: boolean;
  onFilterChange?: () => void;
}) {
  const filterColumns = requestedFilters || EMPTY_COLUMN_FILTERS;
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const table = document.getElementById(tableId);
    if (!(table instanceof HTMLTableElement)) {
      console.error(`Table controls could not find the table with id "${tableId}".`);
      return undefined;
    }
    const headers = [...(table.tHead?.rows[0]?.cells || [])].map((cell) => cell.textContent?.trim().toLocaleLowerCase() || "");
    const filterIndexes = filterColumns
      .map(({ column, label }) => ({
        key: column,
        label: label || column,
        index: headers.indexOf(column.toLocaleLowerCase()),
      }))
      .filter((filter) => filter.index >= 0);
    const query = search.trim().toLocaleLowerCase();

    const updateRows = () => {
      const rows = [...table.tBodies].flatMap((body) => [...body.rows]);
      const dataRows = rows.filter((row) =>
        row.cells.length === headers.length
        && [...row.cells].every((cell) => cell.colSpan === 1)
        && !row.querySelector(".empty, .empty-cell, .daily-report-empty-cell"),
      );
      const nextOptions: Record<string, string[]> = {};
      filterIndexes.forEach(({ key, index }) => {
        nextOptions[key] = [...new Set(dataRows.map((row) => row.cells[index].textContent?.trim() || "").filter(Boolean))]
          .sort((left, right) => left.localeCompare(right));
      });
      setFilters((current) => {
        let changed = false;
        const next = { ...current };
        filterIndexes.forEach(({ key }) => {
          if (next[key] && !nextOptions[key]?.includes(next[key])) {
            next[key] = "";
            changed = true;
          }
        });
        return changed ? next : current;
      });
      setOptions((current) => (
        filterIndexes.every(({ key }) => (current[key] || []).join("\u0000") === (nextOptions[key] || []).join("\u0000"))
          && Object.keys(current).length === Object.keys(nextOptions).length
          ? current
          : nextOptions
      ));

      let visible = 0;
      dataRows.forEach((row) => {
        const matchesSearch = !query || (row.textContent || "").toLocaleLowerCase().includes(query);
        const matchesFilters = filterIndexes.every(({ key, index }) => {
          const value = filters[key] || "";
          return !value || (row.cells[index].textContent?.trim() || "") === value;
        });
        row.hidden = !(matchesSearch && matchesFilters);
        if (matchesSearch && matchesFilters) visible += 1;
      });
      rows.filter((row) => !dataRows.includes(row)).forEach((row) => { row.hidden = false; });
      setVisibleCount(visible);
    };

    const observer = new MutationObserver(updateRows);
    observer.observe(table, { childList: true, characterData: true, subtree: true });
    updateRows();
    return () => observer.disconnect();
  }, [filterColumns, filters, search, tableId]);

  const hasActiveFilters = Boolean(search.trim() || Object.values(filters).some(Boolean));

  return (
    <HorizontalFilterScroller className="table-controls" ariaLabel={ariaLabel}>
      {includeSearch && (
        <label className="search-field table-controls-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => {
              onFilterChange?.();
              setSearch(event.target.value);
            }}
          />
        </label>
      )}
      {filterColumns.map(({ column, label }) => (
        <label className="toolbar-control table-controls-filter" key={column}>
          <span>{label || column}</span>
          <SearchableFilter
            value={filters[column] || ""}
            ariaLabel={`Filter ${ariaLabel.toLocaleLowerCase()} by ${(label || column).toLocaleLowerCase()}`}
            placeholder={`All ${label || column}`.toLocaleLowerCase()}
            options={[
              { value: "", label: `All ${label || column}` },
              ...(options[column] || []).map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => {
              onFilterChange?.();
              setFilters((current) => ({ ...current, [column]: value }));
            }}
          />
        </label>
      ))}
      <span className="table-controls-count" role="status">
        {hasActiveFilters && visibleCount === 0 ? "No matching rows" : `${visibleCount} rows`}
      </span>
    </HorizontalFilterScroller>
  );
}
