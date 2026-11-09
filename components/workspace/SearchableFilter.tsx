"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableFilterOption {
  value: string;
  label: string;
}

export function SearchableFilter({
  value,
  options,
  placeholder,
  ariaLabel,
  allowCustom = false,
  customOptionLabel,
  onChange,
}: {
  value: string;
  options: SearchableFilterOption[];
  placeholder: string;
  ariaLabel: string;
  allowCustom?: boolean;
  customOptionLabel?: (value: string) => string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 180 });
  const availableOptions = useMemo(() => (
    allowCustom && value && !options.some((option) => option.value === value)
      ? [...options, { value, label: customOptionLabel?.(value) || value }]
      : options
  ), [allowCustom, customOptionLabel, options, value]);
  const selected = availableOptions.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const filtered = availableOptions.filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    const customValue = search.trim();
    if (allowCustom && customValue && !availableOptions.some((option) => option.value.toLocaleLowerCase() === customValue.toLocaleLowerCase())) {
      filtered.push({ value: customValue, label: customOptionLabel?.(customValue) || customValue });
    }
    return filtered;
  },
  [allowCustom, availableOptions, customOptionLabel, search]);

  useEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    if (!trigger) return undefined;
    const updatePosition = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
      const menuHeight = Math.min(menuRef.current?.offsetHeight || 280, window.innerHeight - 16);
      const top = rect.bottom + menuHeight + 4 <= window.innerHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - menuHeight - 4);
      setMenuPosition({
        top,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
      });
    };
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.focus();
      }
    };
    updatePosition();
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const selectOption = (option: SearchableFilterOption) => {
    onChange(option.value);
    setOpen(false);
    setSearch("");
    triggerRef.current?.focus();
  };

  return (
    <div className="searchable-filter" ref={rootRef}>
      <button
        ref={triggerRef}
        className="searchable-filter-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setSearch("");
          setOpen((current) => !current);
        }}
      >
        <span>{selected?.label || (allowCustom && value ? value : placeholder)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div className="searchable-filter-menu" ref={menuRef} style={menuPosition}>
          <label className="searchable-filter-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={search}
              aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
              placeholder="Search options"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  menuRef.current?.querySelector<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])')?.focus();
                } else if (event.key === "Enter" && filteredOptions[0]) {
                  event.preventDefault();
                  selectOption(filteredOptions[0]);
                }
              }}
            />
          </label>
          <div className="searchable-filter-options" role="listbox" aria-label={ariaLabel}>
            {filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="searchable-filter-option"
                onClick={() => selectOption(option)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const available = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])') || [])];
                  const currentIndex = available.indexOf(event.currentTarget);
                  available[(currentIndex + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length]?.focus();
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!filteredOptions.length && <div className="searchable-filter-empty">No options found</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
