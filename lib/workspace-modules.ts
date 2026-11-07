export interface WorkspaceModule {
  slug: string;
  title: string;
  section: string;
  description: string;
  columns: string[];
  searchLabel: string;
  actionLabel?: string;
  filters: string[];
}

function defineWorkspaceModule(
  slug: string,
  title: string,
  section: string,
  description: string,
  columns: string[],
  actionLabel?: string,
  filters = ["Status"],
): WorkspaceModule {
  return {
    slug,
    title,
    section,
    description,
    columns,
    searchLabel: `Search ${title.toLowerCase()}`,
    actionLabel,
    filters,
  };
}

export const workspaceSections = [
  {
    title: "Operations",
    modules: [
      defineWorkspaceModule("overview", "Overview", "Operations", "A quick view of branch activity, today's work, and shortcuts to the tools staff use most.", ["Metric", "Today", "Trend"]),
      defineWorkspaceModule("point-of-sale", "Point of sale", "Operations", "Browse branch stock and build a temporary sale basket. Checkout remains disabled until its secure transaction workflow is implemented.", ["Product", "SKU", "Price", "Available stock"], "Start sale", ["Category", "Availability"]),
      defineWorkspaceModule("sales", "Sales", "Operations", "Search receipts, filter sale history, and open or print itemized receipts.", ["Receipt", "Customer", "Status", "Total", "Completed"]),
      defineWorkspaceModule("returns", "Returns", "Operations", "Review return requests, decisions, and refund history.", ["Return", "Sale reference", "Reason", "Status", "Refund", "Created"], "New return", ["Status"]),
      defineWorkspaceModule("daily-report", "Daily report", "Operations", "Review business-day totals and register close information.", ["Business date", "Branch", "Sales", "Refunds", "Cash difference"], undefined, ["Date", "Branch"]),
      defineWorkspaceModule("barcode-labels", "Barcode labels", "Operations", "Search the live catalogue, choose label quantities and sizes, preview CODE 128 labels, and print them.", ["Product", "SKU", "Barcode", "Unit", "Price"], "Prepare labels", ["Category"]),
      defineWorkspaceModule("cloud-sync", "Cloud sync", "Operations", "Review device connectivity and synchronization status.", ["Device", "Last sync", "Pending changes", "Status"]),
      defineWorkspaceModule("settings", "Settings", "Operations", "Review branch, receipt, tax, and device preferences.", ["Setting", "Current value", "Scope"], "Edit settings", ["Setting group"]),
      defineWorkspaceModule("online-orders", "Online orders", "Operations", "Review storefront orders and payment evidence.", ["Order", "Customer", "Order status", "Payment", "Total"], undefined, ["Payment review", "Date range"]),
    ],
  },
  {
    title: "Catalog & stock",
    modules: [
      defineWorkspaceModule("products", "Products", "Catalog & stock", "Browse products, prices, units, and catalog categories.", ["Product", "SKU", "Barcode", "Category", "Unit", "Price", "Availability"], "Add product", ["Category", "Availability"]),
      defineWorkspaceModule("inventory", "Inventory", "Catalog & stock", "Review on-hand quantities, low-stock items, and stock movement history.", ["Product", "SKU", "On hand", "Reorder point", "Last movement"], "Record adjustment", ["Stock level", "Category"]),
      defineWorkspaceModule("purchasing", "Purchasing", "Catalog & stock", "Review supplier purchase orders, received stock, and payments.", ["Purchase", "Supplier", "Date", "Status", "Total"], "New purchase", ["Status", "Date range"]),
      defineWorkspaceModule("transfers", "Transfers", "Catalog & stock", "Track stock transfers between branches from draft through receipt.", ["Transfer", "From", "To", "Created", "Status"], "New transfer", ["Status", "Branch"]),
      defineWorkspaceModule("stock-reports", "Stock reports", "Catalog & stock", "Review stock valuation, movement, and replenishment needs.", ["Product", "Branch", "On hand", "Value", "Reorder status"], undefined, ["Branch", "Category"]),
    ],
  },
  {
    title: "Store portal",
    modules: [
      defineWorkspaceModule("store-dashboard", "Store dashboard", "Store portal", "A branch-level snapshot of sales, stock, and store activity.", ["Metric", "Today", "Trend"]),
      defineWorkspaceModule("store-orders", "Store orders", "Store portal", "Review online orders assigned to the store.", ["Order", "Customer", "Placed", "Payment", "Status"], undefined, ["Status", "Date range"]),
      defineWorkspaceModule("receive-stock", "Receive stock", "Store portal", "Review incoming transfers and quantities awaiting receipt.", ["Transfer", "Source branch", "Items", "Dispatched", "Status"], "Receive transfer", ["Status"]),
      defineWorkspaceModule("store-returns", "Store returns", "Store portal", "Review store return activity and approval status.", ["Return", "Receipt", "Reason", "Requested by", "Status"], "New return"),
      defineWorkspaceModule("store-reports", "Store reports", "Store portal", "Review branch sales, product mix, and payment summaries.", ["Date", "Sales", "Refunds", "Receipts", "Net total"], undefined, ["Date range"]),
    ],
  },
  {
    title: "Admin",
    modules: [
      defineWorkspaceModule("admin-dashboard", "Admin dashboard", "Admin", "A business-wide overview of sales, pending decisions, and recent activity.", ["Metric", "Today", "Trend"]),
      defineWorkspaceModule("report-center", "Report center", "Admin", "Choose a report and review its date and branch scope.", ["Report", "Period", "Branch scope", "Updated"]),
      defineWorkspaceModule("staff-accounts", "Staff accounts", "Admin", "Review staff profiles, branch assignments, and account status.", ["Staff member", "Username", "Branch", "Role", "Status"], "Add staff", ["Branch", "Role", "Status"]),
      defineWorkspaceModule("devices", "Devices", "Admin", "Review registered terminals and their latest connection status.", ["Device", "Branch", "Last seen", "App version", "Status"]),
      defineWorkspaceModule("sales-reports", "Sales reports", "Admin", "Compare sales by day, branch, cashier, product, or payment type.", ["Period", "Branch", "Receipts", "Sales", "Refunds"], undefined, ["Date range", "Branch"]),
      defineWorkspaceModule("profit-tax", "Profit & tax", "Admin", "Review margin and tax summaries for a selected period.", ["Period", "Sales", "Cost", "Gross margin", "Tax"], undefined, ["Date range", "Branch"]),
      defineWorkspaceModule("return-reports", "Return reports", "Admin", "Review returns, reasons, refunds, and restocked quantities.", ["Return", "Branch", "Reason", "Refund", "Date"], undefined, ["Date range", "Branch"]),
      defineWorkspaceModule("hr-payroll", "HR & payroll", "Admin", "Review staff attendance, payroll periods, and payroll records.", ["Staff member", "Period", "Attendance", "Gross pay", "Status"], "New payroll", ["Period", "Branch"]),
      defineWorkspaceModule("audit-log", "Audit log", "Admin", "Review recorded actions and the staff member and branch associated with them.", ["When", "Actor", "Branch", "Action", "Record"], undefined, ["Date range", "Action"]),
      defineWorkspaceModule("store-expenses", "Store expenses", "Admin", "Review branch operating expenses and their categories.", ["Date", "Branch", "Category", "Description", "Amount"], "Record expense", ["Date range", "Branch", "Category"]),
      defineWorkspaceModule("fbr-pct-categories", "FBR PCT categories", "Admin", "Review product tax classification codes and their linked categories.", ["Code", "Description", "Tax rate", "Products", "Status"], "Add category", ["Status"]),
    ],
  },
  {
    title: "Farm ERP",
    modules: [
      defineWorkspaceModule("erp-dashboard", "ERP dashboard", "Farm ERP", "A snapshot of farm operations, production, wholesale, and balances.", ["Metric", "This month", "Trend"]),
      defineWorkspaceModule("animals", "Animals", "Farm ERP", "Review livestock batches, head counts, weights, and feed activity.", ["Batch", "Type", "Head count", "Opened", "Status"], "Open batch", ["Type", "Status"]),
      defineWorkspaceModule("production", "Production", "Farm ERP", "Review production runs, consumed inputs, and finished output.", ["Run", "Product", "Inputs", "Output", "Date"], "New run", ["Date range", "Status"]),
      defineWorkspaceModule("spice", "Spice", "Farm ERP", "Review spice batches, raw inputs, grades, and finished quantities.", ["Batch", "Spice", "Input", "Output", "Status"], "Open batch", ["Status", "Date range"]),
      defineWorkspaceModule("bulk-sales", "Bulk sales", "Farm ERP", "Review wholesale invoices, deliveries, and outstanding balances.", ["Invoice", "Customer", "Date", "Total", "Balance"], "New bulk sale", ["Date range", "Payment"]),
      defineWorkspaceModule("vendors", "Vendors", "Farm ERP", "Review vendor details, purchase history, and outstanding payables.", ["Vendor", "Contact", "Purchases", "Balance", "Status"], "Add vendor", ["Status"]),
      defineWorkspaceModule("farm-stores", "Farm stores", "Farm ERP", "Review farm store locations and their inventory summaries.", ["Store", "Location", "Items", "Stock value", "Status"], "Register store", ["Status"]),
      defineWorkspaceModule("customer-accounts", "Customer accounts", "Farm ERP", "Review customer account activity, invoices, and receivables.", ["Customer", "Phone", "Invoices", "Balance", "Last activity"], "New account", ["Balance", "Status"]),
      defineWorkspaceModule("erp-expenses", "ERP expenses", "Farm ERP", "Review farm and production expenses by category and period.", ["Date", "Category", "Description", "Vendor", "Amount"], "Record expense", ["Date range", "Category"]),
      defineWorkspaceModule("erp-reports", "ERP reports", "Farm ERP", "Review combined farm ledgers for a selected period.", ["Report", "Period", "Records", "Total", "Updated"], undefined, ["Date range", "Report"]),
    ],
  },
] as const;

export const workspaceModules: WorkspaceModule[] = workspaceSections.flatMap((section) => section.modules);

export function getWorkspaceModule(slug: string): WorkspaceModule | undefined {
  return workspaceModules.find((item) => item.slug === slug);
}
