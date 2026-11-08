export type PermissionRole = "cashier" | "manager";

export const PERMISSION_ROLES: readonly PermissionRole[] = ["cashier", "manager"];

export const BRANCH_MODULES = [
  { id: "overview", label: "Overview", viewRoles: ["cashier", "manager"], manageRoles: [] },
  { id: "point_of_sale", label: "Point of sale", viewRoles: ["cashier", "manager"], manageRoles: ["cashier", "manager"] },
  { id: "sales", label: "Sales", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "returns", label: "Returns", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "daily_report", label: "Daily report", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "barcode_labels", label: "Barcode labels", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "settings", label: "Settings", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "orders", label: "Orders", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "products", label: "Products", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "inventory", label: "Inventory", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "purchasing", label: "Purchasing", viewRoles: ["manager"], manageRoles: ["manager"] },
  { id: "transfers", label: "Transfers", viewRoles: ["manager"], manageRoles: ["manager"] },
  { id: "stock_reports", label: "Stock reports", viewRoles: ["manager"], manageRoles: [] },
  { id: "store_dashboard", label: "Store dashboard", viewRoles: ["cashier", "manager"], manageRoles: [] },
  { id: "receive_stock", label: "Receive stock", viewRoles: ["cashier", "manager"], manageRoles: ["manager"] },
  { id: "sales_reports", label: "Store reports", viewRoles: ["cashier", "manager"], manageRoles: [] },
  { id: "staff_accounts", label: "Staff accounts", viewRoles: [], manageRoles: [] },
  { id: "hr_payroll", label: "HR & payroll", viewRoles: ["manager"], manageRoles: [] },
  { id: "store_expenses", label: "Store expenses", viewRoles: ["manager"], manageRoles: [] },
  { id: "pct_categories", label: "FBR PCT categories", viewRoles: [], manageRoles: [] },
  { id: "admin_reports", label: "Admin reports", viewRoles: [], manageRoles: [] },
  { id: "devices", label: "Devices", viewRoles: [], manageRoles: [] },
  { id: "erp_dashboard", label: "ERP dashboard", viewRoles: [], manageRoles: [] },
  { id: "animals", label: "Animals", viewRoles: [], manageRoles: [] },
  { id: "production", label: "Production", viewRoles: [], manageRoles: [] },
  { id: "spice", label: "Spice", viewRoles: [], manageRoles: [] },
  { id: "bulk_sales", label: "Bulk sales", viewRoles: [], manageRoles: [] },
  { id: "vendors", label: "Vendors", viewRoles: ["manager"], manageRoles: [] },
  { id: "cloud_sync", label: "Cloud sync", viewRoles: [], manageRoles: [] },
  { id: "farm_stores", label: "Farm stores", viewRoles: [], manageRoles: [] },
  { id: "customer_accounts", label: "Customer accounts", viewRoles: [], manageRoles: [] },
  { id: "erp_expenses", label: "ERP expenses", viewRoles: [], manageRoles: [] },
  { id: "erp_reports", label: "ERP reports", viewRoles: [], manageRoles: [] },
] as const;

export const BRANCH_ACTIONS = [
  { id: "create_return", label: "Create returns", moduleId: "returns", defaultRoles: ["cashier", "manager"] },
  { id: "manage_categories", label: "Create and edit categories", moduleId: "products", defaultRoles: ["manager"] },
  { id: "create_purchase_order", label: "Create purchase orders", moduleId: "purchasing", defaultRoles: ["manager"] },
  { id: "receive_purchase_order", label: "Receive purchase orders", moduleId: "receive_stock", defaultRoles: ["manager"] },
  { id: "manage_vendors", label: "Manage vendors", moduleId: "vendors", defaultRoles: ["manager"] },
  { id: "create_transfer", label: "Create and manage transfers", moduleId: "transfers", defaultRoles: ["manager"] },
  { id: "receive_transfer", label: "Receive incoming branch transfers", moduleId: "receive_stock", defaultRoles: ["manager"] },
  { id: "manage_staff_accounts", label: "Create and edit staff accounts", moduleId: "staff_accounts", defaultRoles: [] },
  { id: "manage_hr_payroll", label: "Manage HR and payroll records", moduleId: "hr_payroll", defaultRoles: ["manager"] },
  { id: "record_expense", label: "Record expenses", moduleId: "store_expenses", defaultRoles: ["manager"] },
  { id: "manage_pct_categories", label: "Create and edit PCT categories", moduleId: "pct_categories", defaultRoles: [] },
] as const;

export const WEB_ORDER_ACTIONS = [
  { id: "accept", label: "Accept order" },
  { id: "pack", label: "Pack order (deducts stock)" },
  { id: "dispatch", label: "Dispatch delivery" },
  { id: "deliver", label: "Complete handover / pickup" },
  { id: "verify_payment", label: "Verify Easypaisa / JazzCash payment" },
  { id: "cancel", label: "Cancel order" },
] as const;

export const INVENTORY_ACTIONS = [
  { id: "record_stock_movement", label: "Record stock movements" },
  { id: "record_stocktake", label: "Record and review physical stocktakes" },
] as const;

export type BranchModuleId = (typeof BRANCH_MODULES)[number]["id"];
export type BranchActionId = (typeof BRANCH_ACTIONS)[number]["id"];
export type WebOrderActionId = (typeof WEB_ORDER_ACTIONS)[number]["id"];
export type InventoryActionId = (typeof INVENTORY_ACTIONS)[number]["id"];

export function defaultModuleAccess(
  moduleId: BranchModuleId,
  role: PermissionRole,
  mode: "view" | "manage",
): boolean {
  const module = BRANCH_MODULES.find((item) => item.id === moduleId);
  return Boolean(module && (mode === "view" ? module.viewRoles : module.manageRoles)
    .some((allowedRole) => allowedRole === role));
}

export function defaultActionAccess(actionId: BranchActionId, role: PermissionRole): boolean {
  const action = BRANCH_ACTIONS.find((item) => item.id === actionId);
  if (!action) return false;
  return defaultModuleAccess(action.moduleId, role, "manage")
    || action.defaultRoles.some((allowedRole) => allowedRole === role);
}
