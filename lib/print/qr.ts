import { escapeHtml } from "@/lib/print/document";

export interface QrSvgResult {
  svg: string;
  label: string;
}

/**
 * Builds an inline SVG QR code with the same encoder the desktop app uses
 * (`@zxing/library`). Loaded dynamically so it stays out of the main bundle.
 */
export async function buildQrSvg(value: string, label: string): Promise<QrSvgResult> {
  const { BarcodeFormat, QRCodeWriter } = await import("@zxing/library");
  const matrix = new QRCodeWriter().encode(
    value,
    BarcodeFormat.QR_CODE,
    1,
    1,
    new Map(),
  );
  const modules: string[] = [];
  for (let y = 0; y < matrix.getHeight(); y += 1) {
    for (let x = 0; x < matrix.getWidth(); x += 1) {
      if (matrix.get(x, y)) modules.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const width = matrix.getWidth();
  const height = matrix.getHeight();
  return {
    label,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}"><rect width="100%" height="100%" fill="#fff"/><path d="${modules.join("")}" fill="#000"/></svg>`,
  };
}
