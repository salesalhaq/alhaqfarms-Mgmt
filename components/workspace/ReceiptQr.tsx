"use client";

import { useEffect, useState } from "react";
import { buildQrSvg } from "@/lib/print/qr";

export function ReceiptQr({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setSvg("");
    setError("");
    buildQrSvg(value, label)
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "QR unavailable");
      });
    return () => {
      active = false;
    };
  }, [value, label]);

  return (
    <div
      className="receipt-qr"
      data-ready={Boolean(svg)}
      data-error={error || undefined}
    >
      {svg ? (
        <span dangerouslySetInnerHTML={{ __html: svg }} />
      ) : null}
      <small>{error ? `QR unavailable: ${error}` : svg ? label : "Preparing receipt QR…"}</small>
    </div>
  );
}
