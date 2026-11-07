/**
 * EAN-13 weight barcode helpers.
 *
 * Mirrors the Windows desktop app (`getWeightBarcodeProductCode` /
 * `lookupWeightBarcode` in `electron/operations.cjs`):
 *
 *   21 PPPPP QQQQQ C
 *   ^  ^     ^     ^
 *   |  |     |     check digit
 *   |  |     quantity in thousandths (milli-units)
 *   |  product weight-barcode code (1..99999)
 *   weight-barcode prefix
 */

export const WEIGHT_BARCODE_PREFIX = "21";
export const MIN_PRODUCT_CODE = 1;
export const MAX_PRODUCT_CODE = 99_999;
export const MAX_QUANTITY_MILLI = 99_999;

export interface ParsedWeightBarcode {
  productCode: number;
  quantityMilli: number;
}

/** EAN-13 check digit for the first twelve digits. */
export function ean13CheckDigit(body: string): number {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(body[index] || 0) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Build the EAN-13 code printed on a measured weight/volume label. */
export function ean13ForWeight(productCode: number, quantityMilli: number): string {
  const code = Math.trunc(Number(productCode));
  const quantity = Math.trunc(Number(quantityMilli));
  if (!Number.isInteger(code) || code < MIN_PRODUCT_CODE || code > MAX_PRODUCT_CODE) {
    throw new Error("Weight-barcode product code must be between 1 and 99,999.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_MILLI) {
    throw new Error("Weight-barcode quantity must be between 0.001 and 99.999.");
  }
  const body = `${WEIGHT_BARCODE_PREFIX}${String(code).padStart(5, "0")}${String(quantity).padStart(5, "0")}`;
  return `${body}${ean13CheckDigit(body)}`;
}

/**
 * Resolve an EAN-13 weight barcode. Returns `null` for any other barcode so the
 * caller can fall back to a normal SKU/barcode lookup.
 */
export function parseWeightBarcode(code: string): ParsedWeightBarcode | null {
  const value = String(code || "").trim();
  if (!/^\d{13}$/.test(value) || !value.startsWith(WEIGHT_BARCODE_PREFIX)) return null;
  if (!isValidEan13(value)) return null;
  const productCode = Number(value.slice(2, 7));
  const quantityMilli = Number(value.slice(7, 12));
  if (!productCode || !quantityMilli) return null;
  return { productCode, quantityMilli };
}

/** True when the code is a syntactically valid EAN-13 (weight or not). */
export function isEan13(code: string): boolean {
  return /^\d{13}$/.test(String(code || "").trim());
}
