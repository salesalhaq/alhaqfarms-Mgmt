export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface StaffDailyReportShift {
  id: string;
  branch_id: string;
  cashier_id: string;
  status: string;
  opening_cash_paisa: number;
  expected_cash_paisa: number | null;
  counted_cash_paisa: number | null;
  difference_paisa: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface StaffDailyReportClose {
  id: string;
  branch_id: string;
  business_date: string;
  opening_float_paisa: number;
  cash_sales_paisa: number;
  cash_refunds_paisa: number;
  cash_in_paisa: number;
  cash_out_paisa: number;
  expected_cash_paisa: number;
  counted_cash_paisa: number;
  difference_paisa: number;
  gross_sales_paisa: number;
  refunds_paisa: number;
  discount_paisa: number;
  tax_paisa: number;
  sale_count: number;
  return_count: number;
  notes: string | null;
  closed_by: string;
  closed_at: string;
}

export interface StaffDailyReportPayload {
  date: string;
  branchId: string | null;
  branches: { id: string; name: string }[];
  sales: {
    count: number;
    totalPaisa: number;
    discountPaisa: number;
    taxPaisa: number;
    paidPaisa: number;
    duePaisa: number;
  };
  returns: { count: number; refundPaisa: number; restockMilli: number };
  netPaisa: number;
  payments: { method: string; count: number; amount: number }[];
  refundsByMethod: { method: string; count: number; amount: number }[];
  topProducts: {
    product_name: string;
    sku: string | null;
    quantity_milli: number;
    revenue_paisa: number;
  }[];
  cashDrawer: {
    openingFloatPaisa: number;
    cashSalesPaisa: number;
    cashRefundsPaisa: number;
    cashInPaisa: number;
    cashOutPaisa: number;
    expectedCashPaisa: number;
  };
  shifts: StaffDailyReportShift[];
  dayClose: StaffDailyReportClose | null;
  dayCloses: StaffDailyReportClose[];
}

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      branches: Table<{
        id: string;
        code: string;
        name: string;
        is_active: boolean;
        deleted_at: string | null;
      }>;
      cloud_staff: Table<{
        user_id: string;
        local_staff_id: string;
        branch_id: string | null;
        email: string;
        full_name: string;
        role: "cashier" | "manager" | "admin";
        is_active: boolean;
        created_at: string;
        updated_at: string;
      }>;
      audit_log: Table<{
        id: string;
        actor_id: string | null;
        branch_id: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        details_json: Json;
        occurred_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      staff_profiles: Table<{
        id: string;
        branch_id: string | null;
        full_name: string;
        email: string | null;
        phone: string | null;
        role: string;
        is_active: boolean;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        department_id: string | null;
        username: string | null;
        security_version: number;
        pin_reset_required: boolean;
        sessions_invalid_after: string | null;
        permanently_deleted_at: string | null;
        server_updated_at: string;
      }>;
      pos_shifts: Table<{
        id: string;
        branch_id: string;
        cashier_id: string;
        status: string;
        opening_cash_paisa: number;
        expected_cash_paisa: number | null;
        counted_cash_paisa: number | null;
        difference_paisa: number | null;
        opened_at: string;
        closed_at: string | null;
        opening_notes: string | null;
        closing_notes: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      pos_held_sales: Table<{
        id: string;
        branch_id: string;
        cashier_id: string;
        shift_id: string;
        customer_name: string;
        customer_phone: string | null;
        tax_mode: string;
        items_json: Json;
        payments_json: Json;
        status: string;
        created_at: string;
        updated_at: string;
        bill_discount_paisa: number;
        customer_account_id: string | null;
        loyalty_points_redeemed: number;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      branch_module_permissions: Table<{
        id: string;
        branch_id: string;
        role: string;
        permission_key: string;
        is_allowed: boolean;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      }>;
      categories: Table<{
        id: string;
        name: string;
        description: string | null;
        sort_order: number;
        is_active: boolean;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        image_path: string | null;
        server_updated_at: string;
      }>;
      expense_categories: Table<{
        id: string;
        name: string;
        is_active: boolean;
        created_by: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      expenses: Table<{
        id: string;
        branch_id: string;
        category_id: string;
        description: string;
        amount_paisa: number;
        payment_method: string;
        reference: string | null;
        notes: string | null;
        spent_at: string;
        recorded_by: string | null;
        created_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      products: Table<{
        id: string;
        category_id: string | null;
        name: string;
        sku: string | null;
        barcode: string | null;
        unit_code: string;
        price_paisa: number;
        on_sale: boolean;
        discounted_price_paisa: number | null;
        cost_price_paisa: number;
        cost_price_adjustment_paisa: number;
        tax_rate_bps: number;
        tax_rate_override_bps: number | null;
        price_before_tax_paisa: number | null;
        discounted_before_tax_paisa: number | null;
        tax_amount_paisa: number;
        min_stock_milli: number;
        reorder_point_milli: number;
        max_stock_milli: number;
        image_path: string | null;
        is_active: boolean;
        metadata_json: Json;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      stock_movements: Table<{
        id: string;
        idempotency_key: string;
        branch_id: string;
        product_id: string;
        movement_type: string;
        quantity_delta_milli: number;
        unit_cost_paisa: number | null;
        reference_type: string | null;
        reference_id: string | null;
        occurred_at: string;
        created_by: string | null;
        notes: string | null;
        created_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      pos_sales: Table<{
        id: string;
        client_sale_id: string;
        receipt_number: string;
        branch_id: string;
        shift_id: string | null;
        cashier_id: string;
        status: string;
        tax_mode: string;
        subtotal_paisa: number;
        item_discount_paisa: number;
        bill_discount_paisa: number;
        discount_paisa: number;
        tax_paisa: number;
        rounding_paisa: number;
        total_paisa: number;
        paid_paisa: number;
        due_paisa: number;
        change_paisa: number;
        cost_total_paisa: number;
        loyalty_earned: number;
        loyalty_redeemed: number;
        override_by: string | null;
        customer_name: string;
        customer_phone: string | null;
        notes: string | null;
        created_offline: boolean;
        completed_at: string;
        created_at: string;
        updated_at: string;
        customer_account_id: string | null;
        loyalty_discount_paisa: number;
        source_type: string;
        source_order_id: string | null;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      pos_sale_items: Table<{
        id: string;
        sale_id: string;
        line_number: number;
        product_id: string | null;
        product_name: string;
        sku: string | null;
        barcode: string | null;
        unit_code: string;
        quantity_milli: number;
        unit_price_paisa: number;
        unit_cost_paisa: number;
        discount_paisa: number;
        tax_rate_bps: number;
        tax_paisa: number;
        line_total_paisa: number;
        created_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      pos_sale_payments: Table<{
        id: string;
        sale_id: string;
        sequence_number: number;
        method: string;
        amount_paisa: number;
        tendered_paisa: number | null;
        reference: string | null;
        created_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      returns: Table<{
        id: string;
        client_return_id: string;
        return_number: string;
        branch_id: string;
        sale_id: string;
        shift_id: string | null;
        status: string;
        reason: string;
        notes: string | null;
        refund_total_paisa: number;
        restock_total_milli: number;
        created_by: string;
        approved_by: string | null;
        approved_at: string | null;
        rejected_by: string | null;
        rejected_at: string | null;
        rejection_reason: string | null;
        completed_by: string | null;
        completed_at: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      return_items: Table<{
        id: string;
        return_id: string;
        sale_item_id: string;
        product_id: string | null;
        product_name: string;
        unit_code: string;
        quantity_milli: number;
        unit_price_paisa: number;
        line_refund_paisa: number;
        condition: string;
        restock: boolean;
        created_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      return_refunds: Table<{
        id: string;
        return_id: string;
        method: string;
        amount_paisa: number;
        status: string;
        reference: string | null;
        processed_by: string | null;
        processed_at: string | null;
        created_at: string;
        shift_id: string | null;
        credited_paisa: number;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      web_orders: Table<{
        id: string;
        order_number: string;
        branch_id: string;
        status: string;
        fulfillment_type: string;
        customer_name: string;
        customer_phone: string;
        delivery_address: string | null;
        payment_method: string;
        payment_status: string;
        payment_reference: string | null;
        payment_verified_by: string | null;
        payment_verified_at: string | null;
        subtotal_paisa: number;
        tax_paisa: number;
        total_paisa: number;
        notes: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        payment_proof_path: string | null;
        payment_review_status: string;
        payment_rejection_reason: string | null;
        stock_deducted_at: string | null;
        packed_by: string | null;
        packed_at: string | null;
        dispatched_by: string | null;
        dispatched_at: string | null;
        delivered_by: string | null;
        delivered_at: string | null;
        cancelled_by: string | null;
        cancelled_at: string | null;
        sale_id: string | null;
        payment_rejected_by: string | null;
        payment_rejected_at: string | null;
        server_updated_at: string;
      }>;
      web_order_permissions: Table<{
        id: string;
        branch_id: string;
        role: string;
        action: string;
        is_allowed: boolean;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
        server_updated_at: string;
      }>;
      web_order_items: Table<{
        id: string;
        order_id: string;
        line_number: number;
        product_id: string | null;
        product_name: string;
        sku: string | null;
        unit_code: string;
        quantity_milli: number;
        unit_price_paisa: number;
        tax_paisa: number;
        line_total_paisa: number;
      }>;
      web_order_events: Table<{
        id: string;
        order_id: string;
        branch_id: string;
        actor_id: string | null;
        event_type: string;
        previous_status: string | null;
        next_status: string | null;
        payment_reference: string | null;
        notes: string | null;
        occurred_at: string;
      }>;
      web_business_settings: Table<{
        id: string;
        settings: Json;
        updated_at: string;
        updated_by: string;
      }>;
    };
    Views: Record<string, never>;
    Functions: {
      assign_product_weight_barcode_code: {
        Args: { p_product_id: string };
        Returns: number;
      };
      complete_staff_web_enrollment: {
        Args: { p_staff_id: string; p_user_id: string };
        Returns: boolean;
      };
      list_staff_accounts: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          user_id: string | null;
          full_name: string;
          email: string | null;
          username: string | null;
          role: string;
          branch_id: string | null;
          branch_name: string;
          is_active: boolean;
          web_enrolled: boolean;
          pin_configured: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          permanently_deleted_at: string | null;
        }[];
      };
      staff_manage_account: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      issue_staff_credential_invitation: {
        Args: { p_staff_id: string };
        Returns: Json;
      };
      anonymize_cloud_staff_profile: {
        Args: { p_local_staff_id: string };
        Returns: Json;
      };
      get_return_actor_names: {
        Args: { p_return_id: string };
        Returns: {
          actor_id: string;
          full_name: string;
        }[];
      };
      authorize_staff_admin_credential_reset: {
        Args: { p_staff_id: string };
        Returns: Json;
      };
      set_staff_shared_credential_by_admin: {
        Args: {
          p_actor_user_id: string;
          p_staff_id: string;
          p_mode: string;
          p_new_secret: string;
        };
        Returns: number;
      };
      get_staff_overview_metrics: {
        Args: { p_branch_id: string | null; p_day_start: string; p_day_end: string };
        Returns: {
          product_count: number;
          stock_count: number;
          today_sales_count: number;
          today_sales_total_paisa: number;
          open_shift: boolean;
        }[];
      };
      get_staff_pos_catalog: {
        Args: {
          p_branch_id: string;
          p_search: string;
          p_category_id: string | null;
          p_limit: number;
          p_offset: number;
        };
        Returns: {
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
          is_active: boolean;
          stock_milli: number;
          total_count: number;
        }[];
      };
      staff_pos_register_action: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_complete_pos_sale: {
        Args: { p_payload: Json };
        Returns: Json;
      };
      staff_manage_pos_held_sale: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_manage_pos_customer: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_manage_pos_discount: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_manage_return: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      get_staff_pos_tax_rates: {
        Args: { p_branch_id: string; p_product_ids: string[] };
        Returns: { product_id: string; tax_rate_bps: number }[];
      };
      get_staff_daily_report: {
        Args: { p_business_date: string; p_branch_id: string | null };
        Returns: StaffDailyReportPayload;
      };
      get_staff_cashier_daily_report: {
        Args: { p_business_date: string; p_branch_id: string; p_cashier_id: string };
        Returns: StaffDailyReportPayload;
      };
      staff_close_day: {
        Args: { p_payload: Json };
        Returns: Json;
      };
      staff_set_default_branch: {
        Args: { p_branch_id: string };
        Returns: Json;
      };
      staff_manage_web_order: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_manage_purchasing: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
      staff_record_inventory_action: {
        Args: { p_action: string; p_payload: Json };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
