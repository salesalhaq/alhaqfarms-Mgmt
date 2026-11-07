"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  receiptPageCss,
  receiptWidth,
  type ReceiptSettings,
} from "@/lib/print/receipt";
import { ReceiptQr } from "@/components/workspace/ReceiptQr";

export interface ReceiptMetaLine {
  label: string;
  value: string;
}

export interface ReceiptItemLine {
  id: string;
  name: string;
  details: string[];
  amount: string;
}

export interface ReceiptTotalLine {
  label: string;
  value: string;
  detail?: string;
  emphasis?: boolean;
}

export function ReceiptDocument({
  settings,
  branchName,
  documentLabel,
  metadata,
  items,
  totals,
  policy,
  qr,
  footer,
}: {
  settings: ReceiptSettings;
  branchName: string;
  documentLabel: string;
  metadata: ReceiptMetaLine[];
  items: ReceiptItemLine[];
  totals: ReceiptTotalLine[];
  policy?: string;
  qr?: { value: string; label: string };
  footer?: ReactNode;
}) {
  return (
    <>
      <style>{receiptPageCss(settings)}</style>
      <article
        className="receipt-print"
        style={{ "--print-receipt-width": receiptWidth(settings) } as CSSProperties}
      >
        <header className="receipt-business">
          {settings.showLogoOnReceipt && settings.logoDataUrl ? (
            <img
              src={settings.logoDataUrl}
              alt=""
              style={{ maxWidth: "36mm", maxHeight: "18mm", objectFit: "contain" }}
            />
          ) : null}
          <strong>{settings.businessName || branchName}</strong>
          {settings.businessTagline ? <small>{settings.businessTagline}</small> : null}
          {settings.businessAddress ? <small>{settings.businessAddress}</small> : null}
          {settings.businessPhone ? <small>{settings.businessPhone}</small> : null}
          {settings.businessEmail ? <small>{settings.businessEmail}</small> : null}
          <strong className="receipt-document-label">{documentLabel}</strong>
        </header>
        <div className="receipt-meta">
          {metadata.map((entry, index) => (
            <div key={`${entry.label}-${index}`}>
              <span>{entry.label}</span>
              <strong>{entry.value}</strong>
            </div>
          ))}
        </div>
        <div className="receipt-items">
          {items.map((item) => (
            <div className="receipt-item" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                {item.details.map((detail, index) => (
                  <small key={`${item.id}-detail-${index}`}>{detail}</small>
                ))}
              </div>
              <strong>{item.amount}</strong>
            </div>
          ))}
        </div>
        <div className="receipt-totals">
          {totals.map((line, index) => (
            <div className={line.emphasis ? "receipt-total" : undefined} key={`${line.label}-${index}`}>
              <span>
                {line.label}
                {line.detail ? <small className="receipt-total-detail">{line.detail}</small> : null}
              </span>
              <strong>{line.value}</strong>
            </div>
          ))}
        </div>
        {policy ? <p className="receipt-thanks">{policy}</p> : null}
        {qr ? <ReceiptQr value={qr.value} label={qr.label} /> : null}
        <footer className="receipt-thanks">{footer ?? settings.receiptFooter}</footer>
      </article>
    </>
  );
}
