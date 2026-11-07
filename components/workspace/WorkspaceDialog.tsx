"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export function WorkspaceDialog({
  title,
  eyebrow,
  label,
  onClose,
  children,
  footer,
}: {
  title: string;
  eyebrow?: string;
  label?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="sales-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={label || title}
        aria-modal="true"
        className="sales-dialog card"
        role="dialog"
      >
        <header className="sales-dialog-header">
          <div>
            {eyebrow && <p className="eyebrow page">{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button aria-label="Close" className="button secondary" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="workspace-dialog-body">{children}</div>
        {footer && <div className="sales-dialog-actions">{footer}</div>}
      </section>
    </div>
  );
}

export function WorkspaceField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="workspace-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function WorkspaceCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="workspace-checkbox">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

export function WorkspaceError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="notice" role="alert">{message}</div>;
}

export function WorkspaceSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="notice info" role="status">{message}</div>;
}
