"use client";

import {
  AlertCircle, ArrowRight, Camera, LoaderCircle, Minus, Package, Plus,
  ScanLine, Search, ShoppingCart, Trash2, Warehouse, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { useBusinessSettings } from "@/components/BusinessSettingsProvider";
import { formatMoney, formatQuantity } from "@/lib/format";
import { DEFAULT_BRANCH_POS_SETTINGS, type BranchPosSettings } from "@/lib/branch-pos-settings";
import type { WorkspaceModule } from "@/lib/workspace-modules";
import { ReceiptDocument } from "@/components/workspace/ReceiptDocument";
import { HorizontalFilterScroller } from "@/components/workspace/HorizontalFilterScroller";
import { SearchableFilter } from "@/components/workspace/SearchableFilter";
import {
  buildReceiptQrData,
  receiptPageCss,
  receiptPageSize,
} from "@/lib/print/receipt";
import { waitForReceiptQr } from "@/lib/print/print-window";
import { printReceiptElementViaBridge } from "@/lib/print/bridge-print";
import { newIdempotencyKey, postWorkspaceAction } from "@/lib/workspace/write-client";
import { BarcodeScannerDialog } from "./BarcodeScannerDialog";
import { SerialScale } from "./SerialScale";

interface PosProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  image_path: string | null;
  unit_code: string;
  price_paisa: number;
  on_sale: boolean;
  discounted_price_paisa: number | null;
  tax_rate_bps?: number;
  is_active: boolean;
  stock_milli: number;
}

interface PosCategory { id: string; name: string; }
interface CartLine { product: PosProduct; quantityMilli: number; }
interface PosCustomer {
  id: string;
  name: string;
  phone: string | null;
  credit_limit_paisa: number;
  balance_paisa: number;
  available_credit_paisa: number;
  loyalty_points: number;
}
interface PosCustomerResponse {
  customers?: PosCustomer[];
  customer?: PosCustomer;
}
interface PosDiscountRequest {
  id: string;
  branchId: string;
  branchName: string;
  cashierName: string;
  canReview: boolean;
  billDiscountPaisa: number;
  expiresAt: string;
}
interface PosDiscountResponse {
  requests?: PosDiscountRequest[];
  requestId?: string;
  status?: "pending" | "approved" | "declined" | "expired" | "used";
  expiresAt?: string;
}
interface PosResponse {
  products?: PosProduct[];
  categories?: PosCategory[];
  hasMore?: boolean;
  shift?: { openedAt: string } | null;
  posSettings?: BranchPosSettings;
  error?: string;
}
interface HeldSale {
  id: string;
  customerName: string;
  customerPhone: string | null;
  taxMode: "inclusive" | "exclusive";
  items: { productId: string; quantityMilli: number }[];
  payments: { method: string; amount: string; tendered: string; reference?: string }[];
  billDiscountPaisa: number;
  customerAccountId: string | null;
  loyaltyPointsRedeemed: number;
  updatedAt: string;
}
interface HeldSaleResponse {
  heldSales?: HeldSale[];
  held?: {
    id: string;
    taxMode: "inclusive" | "exclusive";
    items: { product: PosProduct; quantityMilli: number }[];
    payments: HeldSale["payments"];
    billDiscountPaisa: number;
    customerAccountId: string | null;
    loyaltyPointsRedeemed: number;
  };
}
interface LookupResponse {
  kind?: "weight" | "product";
  quantityMilli?: number;
  product?: PosProduct;
  error?: string;
}

interface PosPaymentDraft {
  method: string;
  amount: string;
  tendered: string;
  reference: string;
}

interface PosCheckoutResponse {
  sale?: {
    duplicate: boolean;
    id: string;
    receiptNumber: string;
    subtotalPaisa: number;
    taxPaisa: number;
    taxMode: "inclusive" | "exclusive";
    totalPaisa: number;
    paidPaisa: number;
    duePaisa: number;
    changePaisa: number;
    loyaltyEarned: number;
    loyaltyRedeemed: number;
    loyaltyDiscountPaisa: number;
    customerName: string;
  };
}

interface CompletedPayment {
  method: string;
  amountPaisa: number;
  reference: string;
}

function safeProductImage(value: string | null): string | null {
  if (!value || value.length > 1_500_000) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function productPrice(product: PosProduct): number {
  return product.on_sale && product.discounted_price_paisa != null
    ? product.discounted_price_paisa
    : product.price_paisa;
}

function isMeasuredProduct(product: PosProduct): boolean {
  return ["kg", "ltr"].includes(String(product.unit_code || "").toLowerCase());
}

function isRawProduct(product: PosProduct): boolean {
  return String(product.category_name || "").trim().toUpperCase().startsWith("RAW");
}

function quantityStep(product: PosProduct): number {
  return isMeasuredProduct(product) ? 250 : 1000;
}

function quantityInput(milli: number): string {
  return String(Math.round(milli) / 1000);
}

function parseQuantityInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,2}(?:\.\d{1,3})?$/.test(trimmed)) return null;
  const milli = Math.round(Number(trimmed) * 1000);
  return milli >= 1 && milli <= 99_999 ? milli : null;
}

function parseMoneyInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const paisa = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(paisa) ? paisa : null;
}

function roundedTaxPaisa(amountPaisa: number, rateBps: number, taxMode: "inclusive" | "exclusive"): number {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 0 || !Number.isSafeInteger(rateBps)) {
    throw new Error("Tax inputs are outside the supported range.");
  }
  const amount = amountPaisa;
  const rate = Math.max(0, Math.min(rateBps, 10_000));
  const denominator = taxMode === "inclusive" ? 10_000 + rate : 10_000;
  const whole = Math.floor(amount / denominator);
  const remainder = amount % denominator;
  return whole * rate + Math.floor((remainder * rate + denominator / 2) / denominator);
}

export function PointOfSaleWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const { settings: receiptSettings } = useBusinessSettings();
  const canViewAllDiscountRequests = staff?.role === "admin" && !staff.branch_id;
  const [branchId, setBranchId] = useState(staff?.branch_id || "");
  const [approvalBranchFilter, setApprovalBranchFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [offset, setOffset] = useState(0);
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [posSettings, setPosSettings] = useState<BranchPosSettings>({ ...DEFAULT_BRANCH_POS_SETTINGS });
  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState("");
  const [scannerBusy, setScannerBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  const [heldSalesOpen, setHeldSalesOpen] = useState(false);
  const [heldSalesBusy, setHeldSalesBusy] = useState(false);
  const [activeHeldId, setActiveHeldId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<PosCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PosCustomer | null>(null);
  const [customerDialog, setCustomerDialog] = useState(false);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerSearchBusy, setCustomerSearchBusy] = useState(false);
  const [customerSaveBusy, setCustomerSaveBusy] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [loyaltyPointsInput, setLoyaltyPointsInput] = useState("0");
  const [discountApprovalRequestId, setDiscountApprovalRequestId] = useState("");
  const [discountApprovalRequestFingerprint, setDiscountApprovalRequestFingerprint] = useState("");
  const [discountApprovalId, setDiscountApprovalId] = useState("");
  const [discountApprovalFingerprint, setDiscountApprovalFingerprint] = useState("");
  const [discountApprovalBusy, setDiscountApprovalBusy] = useState(false);
  const [managerDiscountRequests, setManagerDiscountRequests] = useState<PosDiscountRequest[]>([]);
  const [registerDialog, setRegisterDialog] = useState<"open_shift" | "close_shift" | "cash_in" | "cash_out" | null>(null);
  const [registerAmount, setRegisterAmount] = useState("");
  const [registerReason, setRegisterReason] = useState("");
  const [registerSaving, setRegisterSaving] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [checkoutDialog, setCheckoutDialog] = useState(false);
  const [checkoutSaleId, setCheckoutSaleId] = useState("");
  const [checkoutSaving, setCheckoutSaving] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [billDiscountInput, setBillDiscountInput] = useState("");
  const [discountDialog, setDiscountDialog] = useState(false);
  const [discountDraft, setDiscountDraft] = useState("");
  const [paymentDrafts, setPaymentDrafts] = useState<PosPaymentDraft[]>([]);
  const [completedSale, setCompletedSale] = useState<PosCheckoutResponse["sale"] | null>(null);
  const [completedLines, setCompletedLines] = useState<CartLine[]>([]);
  const [completedLineDiscounts, setCompletedLineDiscounts] = useState<Record<string, number>>({});
  const [completedPayments, setCompletedPayments] = useState<CompletedPayment[]>([]);
  const [completedDiscountPaisa, setCompletedDiscountPaisa] = useState(0);
  const [completedLoyaltyDiscountPaisa, setCompletedLoyaltyDiscountPaisa] = useState(0);
  const [completedCustomer, setCompletedCustomer] = useState<PosCustomer | null>(null);
  const [completedLoyaltyPoints, setCompletedLoyaltyPoints] = useState(0);
  const [completedAt, setCompletedAt] = useState("");

  const [measuredProduct, setMeasuredProduct] = useState<PosProduct | null>(null);
  const [measuredQuantity, setMeasuredQuantity] = useState("0.500");
  const [measuredInputMode, setMeasuredInputMode] = useState<"manual" | "scale">("manual");
  const [measuredScaleConfirmed, setMeasuredScaleConfirmed] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});

  const searchRef = useRef<HTMLInputElement>(null);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const taxMode = posSettings.taxMode;

  const totalPaisa = useMemo(() => cart.reduce(
    (total, line) => total + Math.round(productPrice(line.product) * line.quantityMilli / 1000),
    0,
  ), [cart]);
  const billDiscountPaisa = billDiscountInput.trim() ? parseMoneyInput(billDiscountInput) : 0;
  const discountApprovalBasketFingerprint = useMemo(() => JSON.stringify({
    billDiscountPaisa: billDiscountPaisa || 0,
    items: cart.map((line) => ({
      productId: line.product.id.toLowerCase(),
      quantityMilli: line.quantityMilli,
    })).sort((left, right) => left.productId.localeCompare(right.productId)),
  }), [billDiscountPaisa, cart]);
  const loyaltyPointsRedeemed = /^\d{1,10}$/.test(loyaltyPointsInput.trim())
    ? Number(loyaltyPointsInput.trim()) : 0;
  const loyaltyDiscountPaisa = loyaltyPointsRedeemed * posSettings.loyaltyPointValuePaisa;
  const invalidLoyaltyRedemption = !/^\d{1,10}$/.test(loyaltyPointsInput.trim())
    || !Number.isSafeInteger(loyaltyDiscountPaisa)
    || (loyaltyPointsRedeemed > 0 && !selectedCustomer)
    || loyaltyPointsRedeemed > (selectedCustomer?.loyalty_points || 0)
    || loyaltyDiscountPaisa > totalPaisa - (billDiscountPaisa || 0);
  const maxBillDiscountPaisa = Math.floor(totalPaisa * posSettings.maxBillDiscountBps / 10_000);
  const discountNeedsManagerApproval = Boolean(staff)
    && (billDiscountPaisa || 0) > Math.min(Math.floor(totalPaisa * 0.03), 10_000);
  let taxDiscountRemaining = (billDiscountPaisa ?? 0)
    + (invalidLoyaltyRedemption ? 0 : loyaltyDiscountPaisa);
  let taxSubtotalRemaining = totalPaisa;
  const saleTaxPaisa = cart.reduce((total, line, index) => {
    const lineSubtotal = Math.round(productPrice(line.product) * line.quantityMilli / 1000);
    const lineDiscount = index === cart.length - 1
      ? taxDiscountRemaining
      : taxSubtotalRemaining > 0
        ? Math.floor(taxDiscountRemaining * lineSubtotal / taxSubtotalRemaining)
        : 0;
    taxDiscountRemaining -= lineDiscount;
    taxSubtotalRemaining -= lineSubtotal;
    return total + roundedTaxPaisa(
      lineSubtotal - lineDiscount,
      line.product.tax_rate_bps || 0,
      taxMode,
    );
  }, 0);
  const saleTotalPaisa = billDiscountPaisa == null || billDiscountPaisa > totalPaisa
    ? totalPaisa
    : totalPaisa - billDiscountPaisa - (invalidLoyaltyRedemption ? 0 : loyaltyDiscountPaisa)
      + (taxMode === "exclusive" ? saleTaxPaisa : 0);
  const invalidBillDiscount = billDiscountPaisa == null
    || billDiscountPaisa > maxBillDiscountPaisa
    || billDiscountPaisa + (invalidLoyaltyRedemption ? 0 : loyaltyDiscountPaisa) > totalPaisa;
  const paymentTotalPaisa = paymentDrafts.reduce((sum, payment) => sum + (parseMoneyInput(payment.amount) || 0), 0);

  const visibleProducts = useMemo(() => products.filter((product) => !isRawProduct(product)), [products]);
  const measuredQuantityMilli = measuredProduct ? parseQuantityInput(measuredQuantity) : null;
  const measuredUnitCode = measuredProduct?.unit_code || "kg";
  const measuredUnitPrice = measuredProduct ? productPrice(measuredProduct) : 0;
  const measuredTotal = measuredProduct && measuredQuantityMilli != null
    ? Math.round(measuredUnitPrice * measuredQuantityMilli / 1000)
    : null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    let active = true;
    if (!branchId) {
      setProducts([]);
      setPosSettings({ ...DEFAULT_BRANCH_POS_SETTINGS });
      setCategories([]);
      setHasMore(false);
      setShiftOpen(false);
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({ branchId, offset: String(offset) });
    if (debouncedSearch) parameters.set("search", debouncedSearch);
    if (categoryId) parameters.set("categoryId", categoryId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/point-of-sale?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as PosResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load the point-of-sale catalog.");
        const page = result.products || [];
        setProducts((current) => offset ? [...current, ...page] : page);
        if (!offset) setPosSettings(result.posSettings || { ...DEFAULT_BRANCH_POS_SETTINGS });
        setCategories(result.categories || []);
        setHasMore(Boolean(result.hasMore));
        setShiftOpen(Boolean(result.shift));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load the point-of-sale catalog.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, categoryId, debouncedSearch, offset, reloadKey]);

  const loadHeldSales = useCallback(async () => {
    if (!branchId) {
      setHeldSales([]);
      return;
    }
    try {
      const result = await postWorkspaceAction<HeldSaleResponse>(
        "/api/workspace/point-of-sale-held-sales",
        { action: "list", branchId },
      );
      setHeldSales(result.heldSales || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load held sales.");
    }
  }, [branchId]);

  const searchPosCustomers = useCallback(async (query: string) => {
    if (!branchId) return;
    setCustomerSearchBusy(true);
    try {
      const result = await postWorkspaceAction<PosCustomerResponse>(
        "/api/workspace/point-of-sale-customers",
        { action: "list", branchId, search: query },
      );
      setCustomers(result.customers || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load customer accounts.");
    } finally {
      setCustomerSearchBusy(false);
    }
  }, [branchId]);

  const createPosCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!branchId) return;
    setCustomerSaveBusy(true);
    setError(null);
    try {
      const result = await postWorkspaceAction<PosCustomerResponse>(
        "/api/workspace/point-of-sale-customers",
        { action: "create", branchId, name: customerName, phone: customerPhone },
      );
      if (!result.customer) throw new Error("The customer account could not be created.");
      setSelectedCustomer(result.customer);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerDialog(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The customer account could not be created.");
    } finally {
      setCustomerSaveBusy(false);
    }
  };

  const loadManagerDiscountRequests = useCallback(async () => {
    if (!["manager", "admin"].includes(staff?.role || "")) return;
    const requestBranchId = canViewAllDiscountRequests ? approvalBranchFilter : branchId;
    if (!requestBranchId) return;
    try {
      const result = await postWorkspaceAction<PosDiscountResponse>(
        "/api/workspace/point-of-sale-discounts",
        { action: "list", branchId: requestBranchId },
      );
      setManagerDiscountRequests(result.requests || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load discount approvals.");
    }
  }, [approvalBranchFilter, branchId, canViewAllDiscountRequests, staff?.role]);

  const requestManagerDiscountApproval = async () => {
    if (!branchId || !discountNeedsManagerApproval
        || (discountApprovalRequestId && discountApprovalRequestFingerprint === discountApprovalBasketFingerprint)
        || (discountApprovalId && discountApprovalFingerprint === discountApprovalBasketFingerprint)) return;
    const requestFingerprint = discountApprovalBasketFingerprint;
    setDiscountApprovalBusy(true);
    setCheckoutError(null);
    try {
      const result = await postWorkspaceAction<PosDiscountResponse>(
        "/api/workspace/point-of-sale-discounts",
        {
          action: "request",
          branchId,
          billDiscountPaisa,
          items: cart.map((line) => ({
            productId: line.product.id,
            quantityMilli: line.quantityMilli,
          })),
        },
      );
      if (!result.requestId) throw new Error("The manager approval request was not created.");
      setDiscountApprovalRequestId(result.requestId);
      setDiscountApprovalRequestFingerprint(requestFingerprint);
      setDiscountApprovalId("");
      setDiscountApprovalFingerprint("");
      setScanNotice("Discount request sent. Waiting for another manager or administrator.");
    } catch (requestError) {
      setCheckoutError(requestError instanceof Error ? requestError.message : "Could not request discount approval.");
    } finally {
      setDiscountApprovalBusy(false);
    }
  };

  const reviewManagerDiscount = async (request: PosDiscountRequest, approve: boolean) => {
    setDiscountApprovalBusy(true);
    try {
      await postWorkspaceAction<PosDiscountResponse>(
        "/api/workspace/point-of-sale-discounts",
        { action: approve ? "approve" : "decline", branchId: request.branchId, requestId: request.id },
      );
      await loadManagerDiscountRequests();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "The discount request could not be reviewed.");
    } finally {
      setDiscountApprovalBusy(false);
    }
  };

  useEffect(() => {
    if (!branchId || !discountApprovalRequestId) return;
    let active = true;
    const pollApproval = async () => {
      try {
        const result = await postWorkspaceAction<PosDiscountResponse>(
          "/api/workspace/point-of-sale-discounts",
          { action: "status", branchId, requestId: discountApprovalRequestId },
        );
        if (!active || result.status === "pending") return;
        setDiscountApprovalRequestId("");
        setDiscountApprovalRequestFingerprint("");
        if (result.status === "approved") {
          setDiscountApprovalId(discountApprovalRequestId);
          setDiscountApprovalFingerprint(discountApprovalRequestFingerprint);
          setScanNotice("Another staff member approved this discount. Complete checkout within two minutes.");
        } else {
          setDiscountApprovalId("");
          setDiscountApprovalFingerprint("");
          setCheckoutError(result.status === "expired"
            ? "The discount approval expired. Request approval again."
            : "The manager declined the discount request.");
        }
      } catch (pollError) {
        if (!active) return;
        setDiscountApprovalRequestId("");
        setDiscountApprovalRequestFingerprint("");
        setCheckoutError(pollError instanceof Error ? pollError.message : "Could not check discount approval.");
      }
    };
    void pollApproval();
    const timer = window.setInterval(() => void pollApproval(), 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [branchId, discountApprovalRequestFingerprint, discountApprovalRequestId]);

  const hasDiscountApprovalForBasket = Boolean(discountApprovalId)
    && discountApprovalFingerprint === discountApprovalBasketFingerprint;
  const hasDiscountRequestForBasket = Boolean(discountApprovalRequestId)
    && discountApprovalRequestFingerprint === discountApprovalBasketFingerprint;

  useEffect(() => {
    if (!["manager", "admin"].includes(staff?.role || "")
        || (!canViewAllDiscountRequests && !branchId)) {
      setManagerDiscountRequests([]);
      return;
    }
    void loadManagerDiscountRequests();
    const timer = window.setInterval(() => void loadManagerDiscountRequests(), 5000);
    return () => window.clearInterval(timer);
  }, [branchId, canViewAllDiscountRequests, loadManagerDiscountRequests, staff?.role]);

  useEffect(() => {
    void loadHeldSales();
  }, [loadHeldSales, reloadKey]);

  const addProduct = useCallback((product: PosProduct, requestedQuantity?: number): boolean => {
    const increment = requestedQuantity ?? Math.min(quantityStep(product), product.stock_milli);
    const existing = cartRef.current.find((line) => line.product.id === product.id)?.quantityMilli || 0;
    const available = Math.max(0, product.stock_milli - existing);
    if (increment <= 0 || increment > available) {
      setError(`Only ${formatQuantity(available)} ${product.unit_code} of ${product.name} remains available for this sale.`);
      return false;
    }
    setError(null);
    setCart((current) => {
      const line = current.find((entry) => entry.product.id === product.id);
      return line
        ? current.map((entry) => entry.product.id === product.id
          ? { ...entry, quantityMilli: entry.quantityMilli + increment }
          : entry)
        : [...current, { product, quantityMilli: increment }];
    });
    return true;
  }, []);

  const selectProduct = useCallback((product: PosProduct): boolean => {
    if (isMeasuredProduct(product)) {
      setMeasuredProduct(product);
      setMeasuredQuantity("0.500");
      setMeasuredInputMode("manual");
      setMeasuredScaleConfirmed(false);
      setError(null);
      return false;
    }
    return addProduct(product);
  }, [addProduct]);

  const lookupCode = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    // A scan while payment, a measured-entry dialog, or a completed sale is on
    // screen must not change the basket behind the cashier's back.
    if (!code || !branchId || scannerBusy || measuredProduct || checkoutDialog || completedSale) return;
    setScannerBusy(true);
    setError(null);
    setScanNotice("");
    try {
      const parameters = new URLSearchParams({ branchId, code });
      const response = await fetch(`/api/workspace/point-of-sale-lookup?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as LookupResponse;
      if (!response.ok || !result.product) {
        throw new Error(result.error || `No active product found for "${code}".`);
      }
      const product = result.product;
      if (isRawProduct(product)) throw new Error("RAW category products cannot be sold at the POS.");
      if (product.stock_milli <= 0) throw new Error(`${product.name} is out of stock at this branch.`);

      if (result.kind === "weight") {
        const quantityMilli = Number(result.quantityMilli);
        if (!Number.isInteger(quantityMilli) || quantityMilli < 1) {
          throw new Error("The weight barcode does not contain a valid quantity.");
        }
        if (addProduct(product, quantityMilli)) {
          setScanNotice(`Added ${formatQuantity(quantityMilli)} ${product.unit_code} of ${product.name}.`);
          setSearch("");
        }
        return;
      }

      if (selectProduct(product)) {
        setScanNotice(`Added ${product.name}.`);
        setSearch("");
      }
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "The scanned code could not be resolved.");
    } finally {
      setScannerBusy(false);
    }
  }, [addProduct, branchId, checkoutDialog, completedSale, measuredProduct, scannerBusy, selectProduct]);

  const closeScanner = useCallback(() => setScannerOpen(false), []);
  const handleScannerDetected = useCallback((code: string) => {
    void lookupCode(code);
  }, [lookupCode]);

  // Keyboard-wedge scanner: rapid printable keystrokes ending in Enter while
  // no form control is focused. Scanners that type into the search box are
  // handled by the search field's own Enter handler.
  useEffect(() => {
    let buffer = "";
    let firstAt = 0;
    let lastAt = 0;
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if (editing || event.ctrlKey || event.altKey || event.metaKey) return;
      const now = Date.now();
      if (event.key === "Enter") {
        if (buffer.length >= 3 && now - firstAt < 1500) {
          event.preventDefault();
          void lookupCode(buffer);
        }
        buffer = "";
        return;
      }
      if (event.key === "Escape") {
        buffer = "";
        return;
      }
      if (event.key.length === 1) {
        if (now - lastAt > 120) {
          buffer = "";
          firstAt = now;
        }
        buffer += event.key;
        lastAt = now;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lookupCode]);

  const changeQuantity = (line: CartLine, change: number) => {
    const nextQuantity = line.quantityMilli + change;
    if (nextQuantity > line.product.stock_milli) {
      setError(`Only ${formatQuantity(line.product.stock_milli)} ${line.product.unit_code} is in branch stock.`);
      return;
    }
    setError(null);
    setCart((current) => nextQuantity <= 0
      ? current.filter((entry) => entry.product.id !== line.product.id)
      : current.map((entry) => entry.product.id === line.product.id
        ? { ...entry, quantityMilli: nextQuantity }
        : entry));
  };

  const commitQuantity = (line: CartLine, value: string) => {
    setQuantityDrafts((current) => {
      const next = { ...current };
      delete next[line.product.id];
      return next;
    });
    const quantityMilli = parseQuantityInput(value);
    if (quantityMilli == null) {
      setError("Enter a quantity with no more than three decimal places.");
      return;
    }
    if (quantityMilli > line.product.stock_milli) {
      setError(`Only ${formatQuantity(line.product.stock_milli)} ${line.product.unit_code} is in stock.`);
      return;
    }
    setError(null);
    setCart((current) => quantityMilli <= 0
      ? current.filter((entry) => entry.product.id !== line.product.id)
      : current.map((entry) => entry.product.id === line.product.id
        ? { ...entry, quantityMilli }
        : entry));
  };

  const addMeasuredToCart = () => {
    if (!measuredProduct || measuredQuantityMilli == null || measuredQuantityMilli <= 0) return;
    if (measuredInputMode === "scale" && !measuredScaleConfirmed) {
      setError("Connect the scale and apply a fresh, stable reading first.");
      return;
    }
    const available = Math.max(
      0,
      measuredProduct.stock_milli - (cartRef.current.find((line) => line.product.id === measuredProduct.id)?.quantityMilli || 0),
    );
    if (measuredQuantityMilli > available) {
      setError(`Only ${formatQuantity(available)} ${measuredUnitCode} of ${measuredProduct.name} remains available for this sale.`);
      return;
    }
    if (addProduct(measuredProduct, measuredQuantityMilli)) {
      setScanNotice(`Added ${formatQuantity(measuredQuantityMilli)} ${measuredUnitCode} of ${measuredProduct.name}.`);
      setMeasuredProduct(null);
    }
  };

  const holdCurrentSale = async () => {
    if (!branchId || !cart.length || !shiftOpen) return;
    setHeldSalesBusy(true);
    setError(null);
    try {
      await postWorkspaceAction("/api/workspace/point-of-sale-held-sales", {
        action: "save",
        branchId,
        ...(activeHeldId ? { id: activeHeldId } : {}),
        items: cart.map((line) => ({
          productId: line.product.id,
          quantityMilli: line.quantityMilli,
        })),
        payments: (paymentDrafts.length ? paymentDrafts : [{
          method: "cash", amount: "", tendered: "", reference: "",
        }]).map(({ method, amount, tendered, reference }) => ({ method, amount, tendered, reference })),
        billDiscountPaisa,
        taxMode,
        customerAccountId: selectedCustomer?.id || null,
        loyaltyPointsRedeemed,
      });
      setCart([]);
      setQuantityDrafts({});
      setBillDiscountInput("");
      setPaymentDrafts([]);
      setActiveHeldId(null);
      setSelectedCustomer(null);
      setLoyaltyPointsInput("0");
      setScanNotice("Sale held. Restore it from Held sales when ready.");
      await loadHeldSales();
    } catch (holdError) {
      setError(holdError instanceof Error ? holdError.message : "The sale could not be held.");
    } finally {
      setHeldSalesBusy(false);
    }
  };

  const resumeHeldSale = async (heldId: string) => {
    if (cart.length) {
      setError("Hold or clear the current basket before restoring a sale.");
      return;
    }
    setHeldSalesBusy(true);
    setError(null);
    try {
      const result = await postWorkspaceAction<HeldSaleResponse>(
        "/api/workspace/point-of-sale-held-sales",
        { action: "resume", branchId, id: heldId },
      );
      if (!result.held) throw new Error("The held sale could not be restored.");
      const restored = result.held;
      if (restored.items.some((line) => isRawProduct(line.product) || !line.product.is_active)) {
        throw new Error("A held sale includes a product that cannot be sold at the POS.");
      }
      setCart(restored.items.map(({ product, quantityMilli }) => ({ product, quantityMilli })));
      setQuantityDrafts({});
      setBillDiscountInput(restored.billDiscountPaisa ? (restored.billDiscountPaisa / 100).toFixed(2) : "");
      setPaymentDrafts(restored.payments.map((payment) => ({
        method: payment.method,
        amount: payment.amount || "",
        tendered: payment.tendered || "",
        reference: payment.reference || "",
      })));
      let restoredCustomer = restored.customerAccountId
        ? customers.find((customer) => customer.id === restored.customerAccountId) || null
        : null;
      if (restored.customerAccountId && !restoredCustomer) {
        const customerResult = await postWorkspaceAction<PosCustomerResponse>(
          "/api/workspace/point-of-sale-customers",
          { action: "list", branchId, customerAccountId: restored.customerAccountId },
        );
        const heldCustomer = customerResult.customers?.[0];
        if (!heldCustomer) throw new Error("The customer on this held sale is no longer available.");
        restoredCustomer = heldCustomer;
        setCustomers((current) => [heldCustomer, ...current.filter((customer) => customer.id !== heldCustomer.id)]);
      }
      setSelectedCustomer(restoredCustomer);
      setLoyaltyPointsInput(String(restored.loyaltyPointsRedeemed || 0));
      setActiveHeldId(restored.id);
      setHeldSalesOpen(false);
      setScanNotice("Held sale restored. Current catalog prices apply at checkout.");
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "The held sale could not be restored.");
    } finally {
      setHeldSalesBusy(false);
    }
  };

  const deleteHeldSale = async (heldId: string) => {
    setHeldSalesBusy(true);
    setError(null);
    try {
      await postWorkspaceAction("/api/workspace/point-of-sale-held-sales", {
        action: "delete",
        branchId,
        id: heldId,
      });
      if (activeHeldId === heldId) setActiveHeldId(null);
      await loadHeldSales();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The held sale could not be deleted.");
    } finally {
      setHeldSalesBusy(false);
    }
  };

  const openRegisterDialog = (action: NonNullable<typeof registerDialog>) => {
    setRegisterDialog(action);
    setRegisterAmount("");
    setRegisterReason("");
    setRegisterError(null);
  };

  const submitRegisterAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!registerDialog || !branchId) return;
    const amountPaisa = parseMoneyInput(registerAmount);
    if (amountPaisa == null) {
      setRegisterError("Enter a valid amount with up to 2 decimal places.");
      return;
    }
    if (registerDialog !== "open_shift" && registerDialog !== "close_shift" && !registerReason.trim()) {
      setRegisterError("Enter a reason for the cash movement.");
      return;
    }

    setRegisterSaving(true);
    setRegisterError(null);
    try {
      await postWorkspaceAction("/api/workspace/point-of-sale-actions", {
        action: registerDialog,
        branchId,
        ...(registerDialog === "open_shift" ? { openingCashPaisa: amountPaisa } : {}),
        ...(registerDialog === "close_shift" ? { countedCashPaisa: amountPaisa } : {}),
        ...(registerDialog === "cash_in" || registerDialog === "cash_out"
          ? { amountPaisa, reason: registerReason.trim() }
          : {}),
        ...((registerDialog === "open_shift" || registerDialog === "close_shift") && registerReason.trim()
          ? { notes: registerReason.trim() }
          : {}),
      });
      setShiftOpen(registerDialog !== "close_shift");
      setRegisterDialog(null);
      setScanNotice(registerDialog === "open_shift"
        ? "Register shift opened."
        : registerDialog === "close_shift"
          ? "Register shift closed."
          : registerDialog === "cash_in"
            ? "Cash added to the drawer."
            : "Cash removed from the drawer.");
      setReloadKey((value) => value + 1);
    } catch (actionError) {
      setRegisterError(actionError instanceof Error ? actionError.message : "The register action could not be saved.");
    } finally {
      setRegisterSaving(false);
    }
  };

  const openCheckout = () => {
    setCheckoutError(null);
    setCheckoutSaleId(newIdempotencyKey());
    setPaymentDrafts([{
      method: "cash",
      amount: (saleTotalPaisa / 100).toFixed(2),
      tendered: "",
      reference: "",
    }]);
    setCheckoutDialog(true);
  };

  const submitCheckout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!branchId || !checkoutSaleId) return;
    if (invalidBillDiscount) {
      setCheckoutError("Bill discount cannot exceed the sale subtotal.");
      return;
    }
    if (invalidLoyaltyRedemption) {
      setCheckoutError("Choose a customer and enter a valid loyalty redemption within the available points.");
      return;
    }
    if (paymentTotalPaisa !== saleTotalPaisa) {
      setCheckoutError("Payment amounts must exactly equal the sale total.");
      return;
    }

    const payments: Array<Record<string, string | number>> = [];
    let creditPaymentPaisa = 0;
    for (const payment of paymentDrafts) {
      const amountPaisa = parseMoneyInput(payment.amount);
      if (amountPaisa == null || amountPaisa <= 0) {
        setCheckoutError("Enter a positive amount for every payment.");
        return;
      }
      const reference = payment.reference.trim();
      if (payment.method === "credit" && !selectedCustomer) {
        setCheckoutError("Select a customer account before taking credit.");
        return;
      }
      if (payment.method === "credit") creditPaymentPaisa += amountPaisa;
      if (["jazzcash", "easypaisa"].includes(payment.method) && !reference) {
        setCheckoutError("Enter the mobile payment transaction ID or sender number.");
        return;
      }
      const tenderedPaisa = payment.method === "cash" && payment.tendered.trim()
        ? parseMoneyInput(payment.tendered)
        : amountPaisa;
      if (tenderedPaisa == null || tenderedPaisa < amountPaisa) {
        setCheckoutError("Cash received cannot be less than the cash payment amount.");
        return;
      }
      payments.push({
        method: payment.method,
        amountPaisa,
        tenderedPaisa,
        reference,
      });
    }
    if (creditPaymentPaisa > (selectedCustomer?.available_credit_paisa || 0)) {
      setCheckoutError("Credit payment exceeds this customer's currently available credit.");
      return;
    }

    setCheckoutSaving(true);
    setCheckoutError(null);
    try {
      const result = await postWorkspaceAction<PosCheckoutResponse>("/api/workspace/point-of-sale-checkout", {
        branchId,
        clientSaleId: checkoutSaleId,
        items: cart.map((line) => ({
          productId: line.product.id,
          quantityMilli: line.quantityMilli,
        })),
        payments,
        billDiscountPaisa,
        taxMode,
        customerAccountId: selectedCustomer?.id || null,
        loyaltyPointsRedeemed,
        ...(hasDiscountApprovalForBasket ? { discountApprovalId } : {}),
        ...(activeHeldId ? { heldSaleId: activeHeldId } : {}),
      });
      if (!result.sale) throw new Error("Checkout returned no sale confirmation.");
      let discountRemaining = (billDiscountPaisa || 0) + loyaltyDiscountPaisa;
      let subtotalRemaining = totalPaisa;
      const lineDiscounts: Record<string, number> = {};
      cart.forEach((line, index) => {
        const lineSubtotal = Math.round(productPrice(line.product) * line.quantityMilli / 1000);
        const lineDiscount = index === cart.length - 1
          ? discountRemaining
          : subtotalRemaining > 0
            ? Math.floor(discountRemaining * lineSubtotal / subtotalRemaining)
            : 0;
        lineDiscounts[line.product.id] = lineDiscount;
        discountRemaining -= lineDiscount;
        subtotalRemaining -= lineSubtotal;
      });
      setCompletedSale(result.sale);
      setCompletedLines(cart);
      setCompletedLineDiscounts(lineDiscounts);
      setCompletedPayments(paymentDrafts.map((payment) => ({
        method: payment.method,
        amountPaisa: parseMoneyInput(payment.amount) || 0,
        reference: payment.reference.trim(),
      })));
      setCompletedDiscountPaisa(billDiscountPaisa || 0);
      setCompletedLoyaltyDiscountPaisa(result.sale.loyaltyDiscountPaisa);
      setCompletedCustomer(selectedCustomer);
      setCompletedLoyaltyPoints(result.sale.loyaltyRedeemed);
      setCompletedAt(new Date().toISOString());
      setActiveHeldId(null);
      setDiscountApprovalRequestId("");
      setDiscountApprovalRequestFingerprint("");
      setDiscountApprovalId("");
      setDiscountApprovalFingerprint("");
      setCheckoutDialog(false);
      setCart([]);
      setQuantityDrafts({});
      setBillDiscountInput("");
      setLoyaltyPointsInput("0");
      setSelectedCustomer(null);
      setScanNotice(result.sale.duplicate
        ? `Sale ${result.sale.receiptNumber} was already recorded.`
        : `Sale ${result.sale.receiptNumber} completed.`);
      setReloadKey((value) => value + 1);
      void loadHeldSales();
    } catch (saveError) {
      setCheckoutError(saveError instanceof Error ? saveError.message : "The sale could not be completed.");
    } finally {
      setCheckoutSaving(false);
    }
  };

  const addPaymentDraft = () => {
    if (paymentDrafts.length >= 10) return;
    const remainder = Math.max(0, saleTotalPaisa - paymentTotalPaisa);
    setPaymentDrafts((current) => [...current, {
      method: "cash",
      amount: (remainder / 100).toFixed(2),
      tendered: "",
      reference: "",
    }]);
  };

  const updatePaymentMethod = (index: number, method: string) => {
    setPaymentDrafts((current) => {
      const remainder = Math.max(0, saleTotalPaisa - current.reduce(
        (sum, payment, paymentIndex) => sum + (paymentIndex === index ? 0 : parseMoneyInput(payment.amount) || 0),
        0,
      ));
      return current.map((payment, paymentIndex) => paymentIndex === index
        ? { ...payment, method, ...(method === "credit" ? { amount: (remainder / 100).toFixed(2) } : {}) }
        : payment);
    });
  };

  const printReceipt = async () => {
    if (!completedSale) return;
    await waitForReceiptQr();
    const element = document.querySelector(".receipt-print");
    const result = await printReceiptElementViaBridge(element, {
      pageCss: receiptPageCss(receiptSettings),
      pageSize: receiptPageSize(receiptSettings),
      title: `Receipt ${completedSale.receiptNumber}`,
      branchId: branchId || null,
    });
    if (!result.printed) window.print();
  };

  return (
    <div className="pos-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>Scan products or weight labels, weigh measured products on a serial or Ethernet scale, and record sales against branch stock.</p>
        </div>
        {!staff?.branch_id && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select className="toolbar-select" value={branchId} onChange={(event) => {
              setBranchId(event.target.value);
              setOffset(0);
              setCart([]);
              setMeasuredProduct(null);
            }}>
              <option value="">Choose a branch</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className={`pos-register-card card ${shiftOpen ? "is-open" : ""}`}>
        <span className="pos-register-icon"><Warehouse size={18} /></span>
        <div className="pos-register-copy">
          <strong>{!branchId ? "Choose a branch to view the register" : shiftOpen ? "Register shift open" : "Register shift is closed"}</strong>
          <small>{!branchId ? "Select an accessible branch to check register status." : shiftOpen ? "An open shift is linked to your staff account." : "Open a shift and enter the starting cash float before recording sales."}</small>
        </div>
        <span className={`pos-shift-status ${shiftOpen ? "open" : ""}`}>{!branchId ? "Not selected" : shiftOpen ? "Active" : "Closed"}</span>
        <div className="pos-register-actions">
          <button
            className="button secondary"
            disabled={!branchId || scannerBusy || Boolean(measuredProduct) || Boolean(completedSale)}
            onClick={() => setScannerOpen(true)}
            type="button"
          ><Camera size={14} /> Camera scan</button>
          {shiftOpen && <>
            <button className="button secondary" disabled={registerSaving} onClick={() => openRegisterDialog("cash_in")} type="button">Cash in</button>
            <button className="button secondary" disabled={registerSaving} onClick={() => openRegisterDialog("cash_out")} type="button">Cash out</button>
          </>}
          <button className="button secondary" disabled={!branchId || heldSalesBusy} onClick={() => {
            setHeldSalesOpen(true);
            void loadHeldSales();
          }} type="button">Held bills <span>{heldSales.length}</span></button>
          <button className="button" disabled={!branchId || registerSaving} onClick={() => openRegisterDialog(shiftOpen ? "close_shift" : "open_shift")} type="button">
            {shiftOpen ? "Close shift" : "Open shift"}
          </button>
        </div>
      </div>

      {["manager", "admin"].includes(staff?.role || "")
        && (canViewAllDiscountRequests || managerDiscountRequests.length > 0) && (
        <section className="card pos-held-sales-list" aria-label="Pending POS discount approvals">
          <div className="sales-dialog-header">
            <div><p className="eyebrow page">Manager review</p><h2>Discount approval requests</h2></div>
            <div className="heading-actions">
              {canViewAllDiscountRequests && (
                <label className="toolbar-control">
                  <span>Approval branch</span>
                  <select className="toolbar-select" value={approvalBranchFilter}
                    onChange={(event) => setApprovalBranchFilter(event.target.value)}>
                    <option value="all">All branches</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                </label>
              )}
              <button className="button secondary" disabled={discountApprovalBusy}
                onClick={() => void loadManagerDiscountRequests()} type="button">Refresh</button>
            </div>
          </div>
          {managerDiscountRequests.length === 0
            ? <p className="empty">No pending discount approvals.</p>
            : managerDiscountRequests.map((request) => (
            <article className="pos-held-sale" key={request.id}>
              <div>
                <strong>{request.cashierName}</strong>
                <small>{request.branchName}</small>
                <small>Requested discount {formatMoney(request.billDiscountPaisa)}</small>
                <small>Expires {new Date(request.expiresAt).toLocaleTimeString()}</small>
              </div>
              {request.canReview
                ? <div>
                  <button className="button" disabled={discountApprovalBusy || Date.parse(request.expiresAt) <= Date.now()}
                    onClick={() => void reviewManagerDiscount(request, true)} type="button">Approve</button>
                  <button className="button secondary" disabled={discountApprovalBusy}
                    onClick={() => void reviewManagerDiscount(request, false)} type="button">Decline</button>
                </div>
                : <small>Another staff member must review this request.</small>}
            </article>
          ))}
        </section>
      )}

      <div className="live-readonly-note pos-readonly-note">
        <AlertCircle size={16} />
        <span>Live catalog · register changes are saved securely. Scanning and weighing update the temporary basket until checkout.</span>
      </div>

      <div className="pos-workspace-grid">
        <div className="pos-catalog-column">
          <button className="pos-customer-button card" disabled={!branchId} onClick={() => {
            setCustomerCreating(false);
            setCustomerDialog(true);
            void searchPosCustomers(customerSearch);
          }} type="button">
            <span>
              <strong>{selectedCustomer?.name || "Walk-in customer"}</strong>
              <small>{selectedCustomer
                ? `${selectedCustomer.phone || "No phone"} · ${selectedCustomer.loyalty_points} loyalty points · ${formatMoney(selectedCustomer.available_credit_paisa)} credit available`
                : "Select a customer account for loyalty or credit"}</small>
            </span>
            <ArrowRight size={15} />
          </button>
          <div className="pos-customer-actions">
            <button className="button secondary" onClick={() => {
              setCustomerCreating(true);
              setCustomerDialog(true);
            }} type="button">New customer account</button>
            {selectedCustomer && <button className="button secondary" onClick={() => {
              setSelectedCustomer(null);
              setLoyaltyPointsInput("0");
            }} type="button">Remove customer</button>}
          </div>
          {selectedCustomer && (
            <label className="field card">
              <span>Redeem loyalty points<small>{selectedCustomer.loyalty_points} available · PKR 1.00 per point</small></span>
              <input inputMode="numeric" min="0" max={selectedCustomer.loyalty_points} value={loyaltyPointsInput}
                onChange={(event) => setLoyaltyPointsInput(event.target.value)} />
            </label>
          )}
          <HorizontalFilterScroller className="pos-catalog-toolbar" ariaLabel="Point of sale product filters">
            <label className="search-field">
              {scannerBusy ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}
              <input
                ref={searchRef}
                aria-label="Search products or scan a SKU, barcode, or weight label"
                placeholder="Search products or scan a SKU / barcode / weight label"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && search.trim()) {
                    event.preventDefault();
                    void lookupCode(search);
                  }
                }}
              />
            </label>
            <label className="toolbar-control">
              <span>Category</span>
              <SearchableFilter
                value={categoryId}
                ariaLabel="Filter point of sale products by category"
                placeholder="All categories"
                options={[
                  { value: "", label: "All categories" },
                  ...categories.map((category) => ({ value: category.id, label: category.name })),
                ]}
                onChange={(value) => {
                  setCategoryId(value);
                  setOffset(0);
                }}
              />
            </label>
            <button className="button secondary" disabled={loading} onClick={() => setReloadKey((value) => value + 1)} type="button">
              {loading ? <LoaderCircle size={15} className="spin" /> : "Refresh"}
            </button>
          </HorizontalFilterScroller>

          <section className="pos-catalog card" aria-label="Branch product catalog">
          {scanNotice && <div className="notice info pos-scan-notice" role="status"><ScanLine size={14} /> {scanNotice}</div>}
          {error && <div className="notice" role="alert">{error}</div>}
          {loading && products.length === 0 && <div className="loading"><LoaderCircle size={18} className="spin" /> Loading branch products…</div>}
          {!branchId && <div className="empty"><Warehouse size={23} /><h2>Select a branch</h2><p>Choose an accessible branch to load products and stock.</p></div>}
          {!loading && branchId && !error && visibleProducts.length === 0 && (
            <div className="empty"><Package size={23} /><h2>{debouncedSearch ? "No matching products" : "No active products found"}</h2><p>Try a different search or category.</p></div>
          )}

          <div className="pos-product-grid">
            {visibleProducts.map((product) => {
              const image = safeProductImage(product.image_path);
              return (
                <button
                  type="button"
                  key={product.id}
                  className="pos-product-card card"
                  disabled={!product.is_active || product.stock_milli <= 0}
                  onClick={() => selectProduct(product)}
                >
                  {image ? <img src={image} alt="" loading="lazy" /> : <span className="pos-product-placeholder"><Package size={22} /></span>}
                  <strong>{product.name}</strong>
                  <small>{product.sku || product.barcode || product.unit_code}</small>
                  <span className="pos-product-price">{formatMoney(productPrice(product))}</span>
                  <span className={`pos-product-stock ${product.stock_milli <= 0 ? "out" : ""}`}>
                    {formatQuantity(product.stock_milli)} {product.unit_code} in stock
                  </span>
                  {isMeasuredProduct(product) && <span className="pos-product-measured">Weigh on scale</span>}
                </button>
              );
            })}
          </div>
          {hasMore && (
            <div className="pos-load-more">
              <button className="button secondary" disabled={loading} onClick={() => setOffset((current) => current + 60)} type="button">
                {loading ? <LoaderCircle size={15} className="spin" /> : "Load more products"}
              </button>
            </div>
          )}
          </section>
        </div>

        <aside className="pos-basket card" aria-label="Temporary sale basket">
          <div className="pos-basket-header">
            <div><h2>Current sale <span>{cart.length}</span></h2><small>Temporary basket · not saved</small></div>
            <button className="button secondary" disabled={!cart.length} onClick={() => { setCart([]); setError(null); setScanNotice(""); }} type="button">
              <Trash2 size={14} /> Clear
            </button>
          </div>

          <div className="pos-basket-lines">
            {cart.map((line) => (
              <div className="pos-basket-line" key={line.product.id}>
                <div className="pos-basket-line-title">
                  <strong>{line.product.name}</strong>
                  <span>{formatMoney(Math.round(productPrice(line.product) * line.quantityMilli / 1000))}</span>
                </div>
                <small>{formatMoney(productPrice(line.product))} / {line.product.unit_code}</small>
                <div className="pos-quantity-controls">
                  <button aria-label={`Decrease ${line.product.name}`} onClick={() => changeQuantity(line, -quantityStep(line.product))} type="button"><Minus size={13} /></button>
                  <input
                    className="pos-quantity-input"
                    aria-label={`${line.product.name} quantity`}
                    inputMode="decimal"
                    value={quantityDrafts[line.product.id] ?? quantityInput(line.quantityMilli)}
                    onChange={(event) => setQuantityDrafts((current) => ({ ...current, [line.product.id]: event.target.value }))}
                    onBlur={(event) => commitQuantity(line, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <button aria-label={`Increase ${line.product.name}`} onClick={() => changeQuantity(line, quantityStep(line.product))} type="button"><Plus size={13} /></button>
                  <button className="pos-remove-line" aria-label={`Remove ${line.product.name}`} onClick={() => setCart((current) => current.filter((entry) => entry.product.id !== line.product.id))} type="button">Remove</button>
                </div>
              </div>
            ))}
            {!cart.length && <div className="pos-basket-empty"><ShoppingCart size={23} /><p>Add products to preview a basket.</p></div>}
          </div>

          <div className="pos-basket-total">
            <div><span>Subtotal</span><strong>{formatMoney(totalPaisa)}</strong></div>
            {billDiscountPaisa != null && billDiscountPaisa > 0 && (
              <div><span>Bill discount</span><strong>−{formatMoney(billDiscountPaisa)}</strong></div>
            )}
            {!invalidLoyaltyRedemption && loyaltyDiscountPaisa > 0 && (
              <div><span>Loyalty discount</span><strong>−{formatMoney(loyaltyDiscountPaisa)}</strong></div>
            )}
            {saleTaxPaisa > 0 && (
              <div><span>Tax ({taxMode})</span><strong>{formatMoney(saleTaxPaisa)}</strong></div>
            )}
            <div><span>Total due</span><strong>{formatMoney(saleTotalPaisa)}</strong></div>
            <small>Final product prices and stock are revalidated when the sale is recorded.</small>
          </div>
          <div className="pos-basket-actions">
            <label className="field">
              <span>Branch tax mode</span>
              <input readOnly value={taxMode === "inclusive" ? "Tax included in prices" : "Add tax to prices"} />
            </label>
            <button className="button secondary" disabled={!cart.length || checkoutSaving} onClick={() => {
              setDiscountDraft(billDiscountInput);
              setCheckoutError(null);
              setDiscountDialog(true);
            }} type="button">Bill discount</button>
            <button className="button secondary" disabled={!shiftOpen || !cart.length || heldSalesBusy || discountNeedsManagerApproval || invalidLoyaltyRedemption} onClick={() => void holdCurrentSale()} type="button">
              {heldSalesBusy ? "Saving…" : "Hold sale"}
            </button>
            <button className="button" disabled={!shiftOpen || !cart.length || invalidBillDiscount || invalidLoyaltyRedemption || (discountNeedsManagerApproval && !hasDiscountApprovalForBasket) || checkoutSaving} onClick={openCheckout} type="button">Take payment</button>
          </div>
          <div className="pos-basket-actions">
            <button className="button secondary" disabled={!completedSale} onClick={printReceipt} type="button">Print receipt</button>
            <button className="button secondary" disabled={!completedSale} onClick={() => {
              setCompletedSale(null);
              setSearch("");
              searchRef.current?.focus();
            }} type="button">New sale</button>
          </div>
          {discountNeedsManagerApproval && (
            <div className="notice" role="status">
              <p>This discount is above the self-approval limit. Another staff member must approve it; approval expires after two minutes.</p>
              {hasDiscountApprovalForBasket
                ? <p>Approved for this exact basket. Complete checkout within two minutes.</p>
                : hasDiscountRequestForBasket
                  ? <p>Waiting for another manager or administrator to review this request.</p>
                  : <button className="button secondary" disabled={discountApprovalBusy || !cart.length}
                    onClick={() => void requestManagerDiscountApproval()} type="button">
                      {discountApprovalBusy ? "Sending request…" : "Request another staff member"}
                    </button>}
              {checkoutError && <p role="alert">{checkoutError}</p>}
            </div>
          )}
          {completedSale && <p className="notice success" role="status">
            Receipt {completedSale.receiptNumber} · {formatMoney(completedSale.totalPaisa)} recorded.
          </p>}
          {completedSale && (
            <ReceiptDocument
              settings={receiptSettings}
              branchName={branches.find((branch) => branch.id === branchId)?.name || "Your branch"}
              documentLabel="SALE RECEIPT"
              metadata={[
                { label: "Receipt", value: completedSale.receiptNumber },
                { label: "Date", value: completedAt ? new Date(completedAt).toLocaleString("en-PK") : "" },
                { label: "Cashier", value: staff?.full_name || "Staff" },
                { label: "Customer", value: completedCustomer?.name || "Walk-in Customer" },
              ]}
              items={completedLines.map((line) => {
                const subtotal = Math.round(productPrice(line.product) * line.quantityMilli / 1000);
                const discount = completedLineDiscounts[line.product.id] || 0;
                const net = subtotal - discount;
                const tax = roundedTaxPaisa(net, line.product.tax_rate_bps || 0, completedSale.taxMode);
                return {
                  id: line.product.id,
                  name: line.product.name,
                  details: [
                    `${formatQuantity(line.quantityMilli)} ${line.product.unit_code} × ${formatMoney(productPrice(line.product))}`,
                    ...(discount > 0 ? [`Discount −${formatMoney(discount)}`] : []),
                  ],
                  amount: formatMoney(net + (completedSale.taxMode === "exclusive" ? tax : 0)),
                };
              })}
              totals={[
                { label: "Subtotal", value: formatMoney(completedSale.subtotalPaisa) },
                ...(completedDiscountPaisa > 0
                  ? [{ label: "Bill discount", value: `− ${formatMoney(completedDiscountPaisa)}` }]
                  : []),
                ...(completedLoyaltyDiscountPaisa > 0
                  ? [{ label: `${completedLoyaltyPoints} loyalty points`, value: `− ${formatMoney(completedLoyaltyDiscountPaisa)}` }]
                  : []),
                ...(!receiptSettings.showTaxOnReceipt || completedSale.taxPaisa <= 0
                  ? []
                  : receiptSettings.taxDisplay === "detailed"
                    ? [...new Set(completedLines.map((line) => line.product.tax_rate_bps || 0))]
                      .filter((rate) => rate > 0)
                      .map((rate) => ({
                        label: `Tax ${rate / 100}%`,
                        value: formatMoney(completedLines
                          .filter((line) => (line.product.tax_rate_bps || 0) === rate)
                          .reduce((sum, line) => {
                            const subtotal = Math.round(productPrice(line.product) * line.quantityMilli / 1000);
                            const discount = completedLineDiscounts[line.product.id] || 0;
                            return sum + roundedTaxPaisa(subtotal - discount, rate, completedSale.taxMode);
                          }, 0)),
                      }))
                    : [{ label: `Tax (${completedSale.taxMode})`, value: formatMoney(completedSale.taxPaisa) }]),
                { label: "Total", value: formatMoney(completedSale.totalPaisa), emphasis: true },
                ...(completedSale.duePaisa > 0
                  ? [{ label: "Credit due", value: formatMoney(completedSale.duePaisa) }]
                  : []),
                ...(completedSale.loyaltyEarned > 0
                  ? [{ label: "Loyalty points earned", value: String(completedSale.loyaltyEarned) }]
                  : []),
                ...completedPayments.map((payment) => ({
                  label: payment.method.replaceAll("_", " "),
                  value: formatMoney(payment.amountPaisa),
                  detail: payment.reference || undefined,
                })),
                ...(completedSale.changePaisa > 0
                  ? [{ label: "Change", value: formatMoney(completedSale.changePaisa) }]
                  : []),
              ]}
              qr={{
                value: buildReceiptQrData({
                  sale: {
                    branch_name: branches.find((branch) => branch.id === branchId)?.name || "Your branch",
                    receipt_number: completedSale.receiptNumber,
                    completed_at: completedAt,
                    cashier_name: staff?.full_name || "Staff",
                    customer_name: completedCustomer?.name || completedSale.customerName || "Walk-in Customer",
                    subtotal_paisa: completedSale.subtotalPaisa,
                    discount_paisa: completedDiscountPaisa + completedLoyaltyDiscountPaisa,
                    loyalty_discount_paisa: completedLoyaltyDiscountPaisa,
                    loyalty_redeemed: completedLoyaltyPoints,
                    loyalty_earned: completedSale.loyaltyEarned,
                    tax_paisa: completedSale.taxPaisa,
                    tax_mode: completedSale.taxMode,
                    rounding_paisa: 0,
                    total_paisa: completedSale.totalPaisa,
                    due_paisa: completedSale.duePaisa,
                    change_paisa: completedSale.changePaisa,
                  },
                  items: completedLines.map((line) => {
                    const subtotal = Math.round(productPrice(line.product) * line.quantityMilli / 1000);
                    const discount = completedLineDiscounts[line.product.id] || 0;
                    const net = subtotal - discount;
                    const tax = roundedTaxPaisa(net, line.product.tax_rate_bps || 0, completedSale.taxMode);
                    return {
                      product_name: line.product.name,
                      unit_code: line.product.unit_code,
                      quantity_milli: line.quantityMilli,
                      unit_price_paisa: productPrice(line.product),
                      discount_paisa: discount,
                      tax_rate_bps: line.product.tax_rate_bps || 0,
                      tax_paisa: tax,
                      line_total_paisa: net + (completedSale.taxMode === "exclusive" ? tax : 0),
                    };
                  }),
                  payments: completedPayments.map((payment, index) => ({
                    sequence_number: index + 1,
                    method: payment.method,
                    amount_paisa: payment.amountPaisa,
                    reference: payment.reference || null,
                  })),
                }),
                label: "Scan for order details · not FBR verified",
              }}
            />
          )}
          <p className="pos-shortcut-note"><kbd>F2</kbd> Focus product search · scan a barcode or weight label at any time</p>
        </aside>
      </div>

      {customerDialog && (
        <div className="sales-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !customerSaveBusy) setCustomerDialog(false);
        }}>
          <section aria-modal="true" className="sales-dialog card" role="dialog" aria-labelledby="pos-customers-title">
            <div className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Register</p>
                <h2 id="pos-customers-title">{customerCreating ? "New customer account" : "Select customer"}</h2>
              </div>
              <button aria-label="Close customer accounts" className="button secondary" disabled={customerSaveBusy}
                onClick={() => setCustomerDialog(false)} type="button"><X size={16} /></button>
            </div>
            {customerCreating ? (
              <form className="form-stack" onSubmit={createPosCustomer}>
                <label className="field"><span>Customer name</span>
                  <input autoFocus maxLength={200} required value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)} />
                </label>
                <label className="field"><span>Phone (optional)</span>
                  <input maxLength={50} value={customerPhone}
                    onChange={(event) => setCustomerPhone(event.target.value)} />
                </label>
                <p className="muted">New POS accounts start with no credit limit. A manager can set a limit in customer account management.</p>
                <div className="modal-actions">
                  <button className="secondary-button" disabled={customerSaveBusy}
                    onClick={() => setCustomerCreating(false)} type="button">Back to customers</button>
                  <button className="primary-button" disabled={customerSaveBusy} type="submit">
                    {customerSaveBusy ? "Creating…" : "Create account"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="form-stack">
                <label className="field"><span>Search by name or phone</span>
                  <input autoFocus maxLength={80} value={customerSearch}
                    onChange={(event) => {
                      setCustomerSearch(event.target.value);
                      void searchPosCustomers(event.target.value);
                    }} />
                </label>
                {customerSearchBusy && <p className="muted">Searching customer accounts…</p>}
                <div className="pos-held-sales-list">
                  {customers.map((customer) => (
                    <article className="pos-held-sale" key={customer.id}>
                      <div>
                        <strong>{customer.name}</strong>
                        <small>{customer.phone || "No phone"} · {customer.loyalty_points} points</small>
                        <small>Credit balance {formatMoney(customer.balance_paisa)} · available {formatMoney(customer.available_credit_paisa)}</small>
                      </div>
                      <button className="button" onClick={() => {
                        setSelectedCustomer(customer);
                        setLoyaltyPointsInput("0");
                        setCustomerDialog(false);
                      }} type="button">Select</button>
                    </article>
                  ))}
                </div>
                {!customerSearchBusy && customers.length === 0 && (
                  <div className="empty"><p>No matching customer accounts.</p></div>
                )}
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setCustomerDialog(false)} type="button">Cancel</button>
                  <button className="primary-button" onClick={() => setCustomerCreating(true)} type="button">New customer account</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {discountDialog && (
        <div className="sales-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDiscountDialog(false);
        }}>
          <section aria-modal="true" className="sales-dialog card" role="dialog" aria-labelledby="pos-discount-title">
            <div className="sales-dialog-header">
              <div><p className="eyebrow page">Discount</p><h2 id="pos-discount-title">Bill discount</h2></div>
              <button aria-label="Close dialog" className="button secondary" onClick={() => setDiscountDialog(false)} type="button"><X size={16} /></button>
            </div>
            <form className="form-stack" onSubmit={(event) => {
              event.preventDefault();
              const paisa = discountDraft.trim() ? parseMoneyInput(discountDraft) : 0;
              if (paisa == null || paisa > totalPaisa || paisa > maxBillDiscountPaisa) {
                setCheckoutError(`Enter a valid discount that does not exceed the branch limit of ${formatMoney(maxBillDiscountPaisa)}.`);
                return;
              }
              setBillDiscountInput(discountDraft);
              setDiscountDialog(false);
              setCheckoutError(null);
            }}>
              <label className="field">
                <span>Discount amount (PKR)<small>Branch limit: {formatMoney(maxBillDiscountPaisa)}. Discounts above the lower of 3% or PKR 100 also require approval from another manager or administrator.</small></span>
                <input autoFocus inputMode="decimal" value={discountDraft} onChange={(event) => setDiscountDraft(event.target.value)} />
              </label>
              {checkoutError && <div className="error-banner" role="alert">{checkoutError}</div>}
              <div className="modal-actions">
                <button className="secondary-button" onClick={() => setDiscountDialog(false)} type="button">Cancel</button>
                <button className="primary-button" type="submit">Apply discount</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {heldSalesOpen && (
        <div className="sales-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !heldSalesBusy) setHeldSalesOpen(false);
        }}>
          <section aria-modal="true" className="sales-dialog card" role="dialog" aria-labelledby="pos-held-sales-title">
            <div className="sales-dialog-header">
              <div><p className="eyebrow page">Register</p><h2 id="pos-held-sales-title">Held sales</h2></div>
              <button aria-label="Close held sales" className="button secondary" disabled={heldSalesBusy} onClick={() => setHeldSalesOpen(false)} type="button"><X size={16} /></button>
            </div>
            {heldSales.length ? (
              <div className="pos-held-sales-list">
                {heldSales.map((held) => (
                  <article className="pos-held-sale" key={held.id}>
                    <div>
                      <strong>{held.customerName || "Walk-in Customer"}</strong>
                      <small>{held.items.length} product lines · {formatMoney(held.billDiscountPaisa)} discount</small>
                      <small>Saved {new Date(held.updatedAt).toLocaleString()}</small>
                    </div>
                    <div>
                      <button className="button" disabled={heldSalesBusy || cart.length > 0} onClick={() => void resumeHeldSale(held.id)} type="button">Restore</button>
                      <button className="button secondary" disabled={heldSalesBusy} onClick={() => void deleteHeldSale(held.id)} type="button">Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty"><ShoppingCart size={23} /><p>No held sales for this register.</p></div>
            )}
            {cart.length > 0 && <p className="muted">Hold or clear the current basket before restoring a sale.</p>}
          </section>
        </div>
      )}

      {checkoutDialog && (
        <div className="sales-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !checkoutSaving) setCheckoutDialog(false);
        }}>
          <section aria-modal="true" className="sales-dialog card" role="dialog" aria-labelledby="pos-checkout-title">
            <div className="sales-dialog-header">
              <div><p className="eyebrow page">Checkout</p><h2 id="pos-checkout-title">Take payment</h2><p className="muted">Total due: {formatMoney(saleTotalPaisa)}</p></div>
              <button aria-label="Close dialog" className="button secondary" disabled={checkoutSaving} onClick={() => setCheckoutDialog(false)} type="button"><X size={16} /></button>
            </div>
            <form className="form-stack" onSubmit={submitCheckout}>
              {paymentDrafts.map((payment, index) => (
                <div className="workspace-form-grid" key={index}>
                  <label className="field">
                    <span>Method</span>
                    <select value={payment.method} onChange={(event) => updatePaymentMethod(index, event.target.value)}>
                      <option value="cash">Cash</option><option value="card">Card</option><option value="jazzcash">JazzCash</option><option value="easypaisa">Easypaisa</option><option value="other">Other</option>
                      <option disabled={!selectedCustomer || selectedCustomer.available_credit_paisa <= 0} value="credit">Customer credit</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Amount (PKR)</span>
                    <input inputMode="decimal" required value={payment.amount} onChange={(event) => setPaymentDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, amount: event.target.value } : entry))} />
                  </label>
                  {payment.method === "cash" && (
                    <label className="field">
                      <span>Cash received (PKR)<small>Leave blank to tender the exact amount.</small></span>
                      <input inputMode="decimal" value={payment.tendered} onChange={(event) => setPaymentDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, tendered: event.target.value } : entry))} />
                    </label>
                  )}
                  {["jazzcash", "easypaisa"].includes(payment.method) && (
                    <label className="field">
                      <span>Transaction ID / sender number</span>
                      <input maxLength={100} required value={payment.reference} onChange={(event) => setPaymentDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, reference: event.target.value } : entry))} />
                    </label>
                  )}
                  {paymentDrafts.length > 1 && <button className="text-button" disabled={checkoutSaving} onClick={() => setPaymentDrafts((current) => current.filter((_, entryIndex) => entryIndex !== index))} type="button">Remove payment</button>}
                </div>
              ))}
              <div className="pos-basket-actions">
                <button className="button secondary" disabled={checkoutSaving || paymentDrafts.length >= 10} onClick={addPaymentDraft} type="button">Add payment method</button>
                <span>Paid: {formatMoney(paymentTotalPaisa)} / {formatMoney(saleTotalPaisa)}</span>
              </div>
              {checkoutError && <div className="error-banner" role="alert">{checkoutError}</div>}
              <div className="modal-actions">
                <button className="secondary-button" disabled={checkoutSaving} onClick={() => setCheckoutDialog(false)} type="button">Cancel</button>
                <button className="primary-button" disabled={checkoutSaving || paymentTotalPaisa !== saleTotalPaisa} type="submit">{checkoutSaving ? <LoaderCircle size={14} className="spin" /> : null}{checkoutSaving ? "Recording…" : `Complete sale · ${formatMoney(saleTotalPaisa)}`}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {measuredProduct && (
        <div
          className="sales-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMeasuredProduct(null);
          }}
        >
          <section
            aria-label={`${measuredProduct.name} measured quantity`}
            aria-modal="true"
            className="sales-dialog pos-measured-dialog card"
            role="dialog"
          >
            <div className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Measured product</p>
                <h2>{measuredProduct.name}</h2>
                <p className="muted">
                  {formatMoney(measuredUnitPrice)}/{measuredUnitCode} · {formatQuantity(measuredProduct.stock_milli)} {measuredUnitCode} left
                </p>
              </div>
              <button aria-label="Close measured quantity" className="button secondary" onClick={() => setMeasuredProduct(null)} type="button"><X size={16} /></button>
            </div>

            <form className="pos-measured-quantity" onSubmit={(event) => { event.preventDefault(); addMeasuredToCart(); }}>
              <div className="pos-measured-fields">
                <label className="field">
                  <span>Quantity ({measuredUnitCode})</span>
                  <input
                    autoFocus
                    inputMode="decimal"
                    aria-label={`Quantity in ${measuredUnitCode}`}
                    placeholder="0.000"
                    readOnly={measuredInputMode === "scale"}
                    value={measuredQuantity}
                    onChange={(event) => {
                      setMeasuredQuantity(event.target.value);
                      setMeasuredScaleConfirmed(false);
                    }}
                  />
                </label>
                <label className="field">
                  <span>Unit</span>
                  <input value={measuredUnitCode} readOnly />
                </label>
              </div>

              <div className="pos-measured-mode">
                <button type="button" className={measuredInputMode === "manual" ? "active" : ""} onClick={() => { setMeasuredInputMode("manual"); setMeasuredScaleConfirmed(false); }}>Manual</button>
                <button type="button" className={measuredInputMode === "scale" ? "active" : ""} onClick={() => { setMeasuredInputMode("scale"); setMeasuredScaleConfirmed(false); }}>From scale</button>
              </div>

              {measuredInputMode === "scale" && (
                <SerialScale
                  key={`${measuredProduct.id}-${branchId}`}
                  unitCode={measuredUnitCode}
                  branchId={branchId}
                  onUseReading={(quantity) => {
                    setMeasuredQuantity(quantityInput(Math.round(quantity * 1000)));
                    setMeasuredScaleConfirmed(true);
                  }}
                />
              )}

              {measuredInputMode === "manual" && (
                <div className="pos-measured-presets">
                  {[250, 500, 1000, 2000, 5000].map((preset) => (
                    <button type="button" key={preset} onClick={() => setMeasuredQuantity(quantityInput(preset))}>
                      {formatQuantity(preset)} {measuredUnitCode}
                    </button>
                  ))}
                </div>
              )}

              {error && <div className="error-banner">{error}</div>}
              <strong className="pos-measured-total">{measuredTotal == null ? "—" : formatMoney(measuredTotal)}</strong>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setMeasuredProduct(null)}>Cancel</button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={measuredQuantityMilli == null || measuredQuantityMilli <= 0 || (measuredInputMode === "scale" && !measuredScaleConfirmed)}
                >
                  Add
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {registerDialog && (
        <div className="sales-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !registerSaving) setRegisterDialog(null);
        }}>
          <section aria-modal="true" className="sales-dialog card" role="dialog" aria-labelledby="pos-register-dialog-title">
            <div className="sales-dialog-header">
              <div>
                <p className="eyebrow page">Register</p>
                <h2 id="pos-register-dialog-title">
                  {registerDialog === "open_shift" ? "Open shift" :
                    registerDialog === "close_shift" ? "Close shift" :
                      registerDialog === "cash_in" ? "Record cash in" : "Record cash out"}
                </h2>
              </div>
              <button aria-label="Close dialog" className="button secondary" disabled={registerSaving} onClick={() => setRegisterDialog(null)} type="button"><X size={16} /></button>
            </div>
            <form className="form-stack" onSubmit={submitRegisterAction}>
              <label className="field">
                <span>{registerDialog === "open_shift" ? "Opening cash float (PKR)" : registerDialog === "close_shift" ? "Counted cash (PKR)" : "Amount (PKR)"}</span>
                <input autoFocus inputMode="decimal" required value={registerAmount} onChange={(event) => setRegisterAmount(event.target.value)} />
              </label>
              <label className="field">
                <span>{registerDialog === "cash_in" || registerDialog === "cash_out" ? "Reason" : "Notes (optional)"}</span>
                <textarea maxLength={registerDialog === "cash_in" || registerDialog === "cash_out" ? 200 : 500} required={registerDialog === "cash_in" || registerDialog === "cash_out"} rows={3} value={registerReason} onChange={(event) => setRegisterReason(event.target.value)} />
              </label>
              {registerError && <div className="error-banner" role="alert">{registerError}</div>}
              <div className="modal-actions">
                <button className="secondary-button" disabled={registerSaving} onClick={() => setRegisterDialog(null)} type="button">Cancel</button>
                <button className="primary-button" disabled={registerSaving} type="submit">{registerSaving ? <LoaderCircle size={14} className="spin" /> : null}{registerSaving ? "Saving…" : "Save"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      <BarcodeScannerDialog open={scannerOpen} onClose={closeScanner} onDetected={handleScannerDetected} />
    </div>
  );
}
