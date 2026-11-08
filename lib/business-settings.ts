import {
  DEFAULT_RECEIPT_SETTINGS,
  type ReceiptSettings,
} from "@/lib/print/receipt";

export interface BusinessSettings extends ReceiptSettings {
  businessWebsite: string;
}

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  ...DEFAULT_RECEIPT_SETTINGS,
  businessWebsite: "",
};

const MAX_LOGO_DATA_URL_LENGTH = 2_100_000;

export function parseBusinessSettings(value: unknown): BusinessSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Business settings have an invalid format.");
  }
  const record = value as Record<string, unknown>;
  const text = (key: string, fallback: string, maxLength: number): string => {
    const item = record[key] ?? fallback;
    if (typeof item !== "string" || item.length > maxLength) {
      throw new Error("Business settings contain an invalid text value.");
    }
    return item.trim();
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const item = record[key] ?? fallback;
    if (typeof item !== "boolean") throw new Error("Business settings contain an invalid option.");
    return item;
  };
  const businessEmail = text("businessEmail", DEFAULT_BUSINESS_SETTINGS.businessEmail, 254);
  if (businessEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
    throw new Error("Enter a valid business email address.");
  }
  const businessWebsite = text("businessWebsite", "", 254);
  if (businessWebsite) {
    try {
      const website = new URL(businessWebsite);
      if (website.protocol !== "http:" && website.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Enter a valid business website URL.");
    }
  }

  const logoDataUrl = text("logoDataUrl", "", MAX_LOGO_DATA_URL_LENGTH);
  if (logoDataUrl && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(logoDataUrl)) {
    throw new Error("Choose a supported PNG, JPEG, WebP, or GIF logo.");
  }

  const taxDisplay = text("taxDisplay", DEFAULT_BUSINESS_SETTINGS.taxDisplay, 12);
  if (taxDisplay !== "summary" && taxDisplay !== "detailed") {
    throw new Error("Choose a valid receipt tax display.");
  }
  const paperSize = text("paperSize", DEFAULT_BUSINESS_SETTINGS.paperSize, 8);
  if (paperSize !== "80mm" && paperSize !== "58mm" && paperSize !== "A4") {
    throw new Error("Choose a valid receipt paper size.");
  }

  return {
    businessName: text("businessName", DEFAULT_BUSINESS_SETTINGS.businessName, 200),
    businessTagline: text("businessTagline", "", 200),
    businessAddress: text("businessAddress", "", 500),
    businessPhone: text("businessPhone", "", 50),
    businessEmail,
    businessWebsite,
    logoDataUrl,
    showLogoOnReceipt: boolean("showLogoOnReceipt", true),
    showTaxOnReceipt: boolean("showTaxOnReceipt", true),
    taxDisplay,
    paperSize,
    receiptFooter: text("receiptFooter", DEFAULT_BUSINESS_SETTINGS.receiptFooter, 300),
    returnPolicy: text("returnPolicy", "", 2000),
  };
}
