export interface BranchPosSettings {
  taxMode: "inclusive" | "exclusive";
  taxRateBps: number;
  taxRoundingScope: "per_line" | "per_sale";
  taxRoundingMethod: "half_up" | "down" | "up";
  taxRoundingIncrementPaisa: 1 | 5 | 10 | 25 | 50 | 100;
  taxDisplay: "summary" | "detailed";
  maxItemDiscountBps: number;
  maxBillDiscountBps: number;
  loyaltyPointsPer100: number;
  loyaltyPointValuePaisa: number;
  lowStockThreshold: number;
  allowNegativeStock: boolean;
}

export const DEFAULT_BRANCH_POS_SETTINGS: BranchPosSettings = {
  taxMode: "inclusive",
  taxRateBps: 0,
  taxRoundingScope: "per_line",
  taxRoundingMethod: "half_up",
  taxRoundingIncrementPaisa: 1,
  taxDisplay: "summary",
  maxItemDiscountBps: 10_000,
  maxBillDiscountBps: 10_000,
  loyaltyPointsPer100: 1,
  loyaltyPointValuePaisa: 100,
  lowStockThreshold: 3,
  allowNegativeStock: false,
};

export interface BranchFbrSettings {
  environment: "sandbox" | "production";
  baseUrl: string;
  registrationNumber: string;
  posId: string;
  paymentMode: number;
  clientId: string;
  enabled: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
  hasApiKey: boolean;
}

export const DEFAULT_BRANCH_FBR_SETTINGS: BranchFbrSettings = {
  environment: "sandbox",
  baseUrl: "",
  registrationNumber: "",
  posId: "",
  paymentMode: 0,
  clientId: "",
  enabled: false,
  hasUsername: false,
  hasPassword: false,
  hasApiKey: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseBranchPosSettings(value: unknown): BranchPosSettings {
  if (!isRecord(value)) throw new Error("Branch POS settings have an invalid format.");
  const defaults = DEFAULT_BRANCH_POS_SETTINGS;
  const taxMode = value.tax_mode ?? defaults.taxMode;
  const taxRoundingScope = value.tax_rounding_scope ?? defaults.taxRoundingScope;
  const taxRoundingMethod = value.tax_rounding_method ?? defaults.taxRoundingMethod;
  const taxRoundingIncrement = value.tax_rounding_increment_paisa ?? defaults.taxRoundingIncrementPaisa;
  const taxDisplay = value.tax_display ?? defaults.taxDisplay;
  const readInteger = (input: unknown, fallback: number): number => {
    const candidate = input ?? fallback;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
      throw new Error("Branch POS settings contain an invalid number.");
    }
    return candidate;
  };
  const taxRateBps = readInteger(value.tax_rate_bps, defaults.taxRateBps);
  const maxItemDiscountBps = readInteger(value.max_item_discount_bps, defaults.maxItemDiscountBps);
  const maxBillDiscountBps = readInteger(value.max_bill_discount_bps, defaults.maxBillDiscountBps);
  const loyaltyPointsPer100 = readInteger(value.loyalty_points_per_100, defaults.loyaltyPointsPer100);
  const loyaltyPointValuePaisa = readInteger(value.loyalty_point_value_paisa, defaults.loyaltyPointValuePaisa);
  const lowStockThreshold = readInteger(value.low_stock_threshold, defaults.lowStockThreshold);
  const result = {
    taxMode,
    taxRateBps,
    taxRoundingScope,
    taxRoundingMethod,
    taxRoundingIncrementPaisa: Number(taxRoundingIncrement) as BranchPosSettings["taxRoundingIncrementPaisa"],
    taxDisplay,
    maxItemDiscountBps,
    maxBillDiscountBps,
    loyaltyPointsPer100,
    loyaltyPointValuePaisa,
    lowStockThreshold,
    allowNegativeStock: value.allow_negative_stock ?? defaults.allowNegativeStock,
  };
  if (taxMode !== "inclusive" && taxMode !== "exclusive") throw new Error("Choose a supported tax mode.");
  if (taxRoundingScope !== "per_line" && taxRoundingScope !== "per_sale") throw new Error("Choose a supported tax rounding scope.");
  if (taxRoundingMethod !== "half_up" && taxRoundingMethod !== "down" && taxRoundingMethod !== "up") {
    throw new Error("Choose a supported tax rounding method.");
  }
  if (![1, 5, 10, 25, 50, 100].includes(Number(taxRoundingIncrement))) {
    throw new Error("Choose a supported tax rounding increment.");
  }
  if (taxDisplay !== "summary" && taxDisplay !== "detailed") throw new Error("Choose a supported receipt tax display.");
  const integers: Array<[number, number, number]> = [
    [taxRateBps, 0, 10_000],
    [maxItemDiscountBps, 0, 10_000],
    [maxBillDiscountBps, 0, 10_000],
    [loyaltyPointsPer100, 0, 10_000],
    [loyaltyPointValuePaisa, 1, 1_000_000],
    [lowStockThreshold, 0, 1_000_000],
  ];
  if (integers.some(([number, minimum, maximum]) =>
    typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum
  )) {
    throw new Error("Branch POS settings contain an invalid number.");
  }
  if (typeof result.allowNegativeStock !== "boolean") {
    throw new Error("Branch POS settings contain an invalid stock option.");
  }
  return {
    ...result,
    taxMode: taxMode as BranchPosSettings["taxMode"],
    taxRoundingScope: taxRoundingScope as BranchPosSettings["taxRoundingScope"],
    taxRoundingMethod: taxRoundingMethod as BranchPosSettings["taxRoundingMethod"],
    taxDisplay: taxDisplay as BranchPosSettings["taxDisplay"],
    allowNegativeStock: result.allowNegativeStock as boolean,
  };
}
