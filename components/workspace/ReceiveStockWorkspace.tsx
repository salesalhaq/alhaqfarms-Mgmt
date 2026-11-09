"use client";

import { AlertCircle, Eye, LoaderCircle, PackageCheck, RefreshCw, Truck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";
import { TableDocumentTools } from "@/components/workspace/TableDocumentTools";
import { TableControls } from "@/components/workspace/TableControls";
import { formatDateTime, formatMoney, formatQuantity, labelize, statusTone } from "@/lib/format";
import { postWorkspaceAction } from "@/lib/workspace/write-client";
import type { WorkspaceModule } from "@/lib/workspace-modules";

interface IncomingTransfer {
  id: string;
  transfer_number: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  status: string;
  notes: string | null;
  dispatched_at: string | null;
  received_at: string | null;
  created_at: string;
  item_count: number;
  quantity_milli: number;
  received_quantity_milli: number;
}

interface TransferItem {
  id: string;
  product_name: string;
  unit_code: string;
  quantity_milli: number;
  received_quantity_milli: number;
  unit_cost_paisa: number;
}

interface ReceiveStockResponse {
  incoming: IncomingTransfer[];
  received: IncomingTransfer[];
  summary: {
    arriving: number;
    unitsInTransit: number;
    receivedRecently: number;
    branchName?: string;
    canReceive?: boolean;
  };
  note?: string;
  error?: string;
}

interface TransferDetail {
  transfer: IncomingTransfer;
  items: TransferItem[];
  error?: string;
}

export function ReceiveStockWorkspace({ item }: { item: WorkspaceModule }) {
  const { staff, branches } = useStaffAuth();
  const [branchId, setBranchId] = useState(staff?.role === "admin" ? "all" : staff?.branch_id || "");
  const [payload, setPayload] = useState<ReceiveStockResponse | null>(null);
  const [detail, setDetail] = useState<TransferDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const quantityToMilli = (value: string): number | null => {
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!match) return null;
    const total = Number(match[1]) * 1000 + Number((match[2] || "").padEnd(3, "0"));
    return Number.isSafeInteger(total) ? total : null;
  };

  const milliToInput = (value: number): string =>
    (value / 1000).toFixed(3).replace(/\.?0+$/, "");

  useEffect(() => {
    if (!staff) return;
    if (staff.role === "admin" && !branchId) setBranchId("all");
    else if (staff.branch_id && !branchId) setBranchId(staff.branch_id);
  }, [branchId, staff]);

  useEffect(() => {
    if (!staff) return undefined;
    let active = true;
    setLoading(true);
    setError(null);

    const parameters = new URLSearchParams();
    if (branchId) parameters.set("branchId", branchId);

    void (async () => {
      try {
        const response = await fetch(`/api/workspace/receive-stock?${parameters.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as ReceiveStockResponse;
        if (!active) return;
        if (!response.ok) throw new Error(result.error || "Could not load incoming transfers.");
        setPayload(result);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load incoming transfers.");
        setPayload(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [branchId, reloadKey, staff]);

  const openDetail = async (transfer: IncomingTransfer) => {
    setDetailLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/receive-stock?detailId=${encodeURIComponent(transfer.id)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json() as TransferDetail;
      if (!response.ok) throw new Error(result.error || "Could not load the transfer lines.");
      setDetail(result);
      setReceiveQuantities(Object.fromEntries(result.items.map((line) => [line.id, milliToInput(line.quantity_milli)])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the transfer lines.");
    } finally {
      setDetailLoading(false);
    }
  };

  const confirmReceipt = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    const items: Array<{ itemId: string; receivedQuantityMilli: number }> = [];
    for (const line of detail.items) {
      const receivedQuantityMilli = quantityToMilli(receiveQuantities[line.id] || "");
      if (receivedQuantityMilli == null || receivedQuantityMilli > line.quantity_milli) {
        setError(`Received quantity for ${line.product_name} must be between zero and the sent quantity.`);
        return;
      }
      items.push({ itemId: line.id, receivedQuantityMilli });
    }
    if (!window.confirm("Confirm the quantities that arrived at this branch?")) return;
    setActionBusy(true);
    setError(null);
    setActionMessage(null);
    try {
      await postWorkspaceAction("/api/workspace/transfers", {
        action: "receive",
        transferId: detail.transfer.id,
        items,
      });
      const shortLines = detail.items.filter((line, index) =>
        items[index].receivedQuantityMilli < line.quantity_milli
      ).length;
      setActionMessage(shortLines
        ? `Transfer received with ${shortLines} short line${shortLines === 1 ? "" : "s"}. Confirmed stock has been added to this branch.`
        : "Transfer received in full. Confirmed stock has been added to this branch.");
      setReloadKey((value) => value + 1);
      await openDetail(detail.transfer);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The transfer could not be received.");
    } finally {
      setActionBusy(false);
    }
  };

  const summary = payload?.summary;
  const receiptCounts = detail?.items.reduce((totals, line) => {
    const entered = quantityToMilli(receiveQuantities[line.id] || "") ?? 0;
    totals.expected += line.quantity_milli;
    totals.counting += Math.min(entered, line.quantity_milli);
    if (entered < line.quantity_milli) totals.shortLines += 1;
    totals.lines += 1;
    return totals;
  }, { expected: 0, counting: 0, shortLines: 0, lines: 0 });
  const cards = summary ? [
    { label: "Arriving", value: summary.arriving.toLocaleString(), note: "Dispatched transfers not yet received" },
    { label: "Units in transit", value: formatQuantity(summary.unitsInTransit), note: "Across incoming transfers" },
    { label: "Received recently", value: summary.receivedRecently.toLocaleString(), note: "Last 20 incoming transfers" },
    { label: "Branch", value: summary.branchName || "Your branch", note: "Receipts post to the destination branch" },
  ] : [];

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow page">{item.section}</p>
          <h1>{item.title}</h1>
          <p>{item.description} Confirm what actually arrived from another branch.</p>
        </div>
        <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={15} /> Loading…</> : <><RefreshCw size={15} /> Refresh</>}
        </button>
      </div>

      <div className="notice info" role="note">
        <PackageCheck size={16} />
        <span>{payload?.note || "Confirm received quantities to post stock movements to the destination branch."}</span>
      </div>
      {actionMessage && <div className="notice info" role="status">{actionMessage}</div>}

      <div className="daily-report-toolbar daily-report-no-print">
        {staff?.role === "admin" && (
          <label className="toolbar-control">
            <span>Branch</span>
            <select
              className="toolbar-select"
              value={branchId || "all"}
              onChange={(event) => {
                setDetail(null);
                setBranchId(event.target.value);
              }}
            >
              <option value="all">All accessible branches</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && (
        <div className="card panel" role="alert">
          <div className="inline-message error"><AlertCircle size={16} /><span>{error}</span></div>
        </div>
      )}

      {loading && !payload && <div className="card loading"><LoaderCircle size={18} className="spin" /> Loading incoming transfers…</div>}

      {!loading && payload && (
        <>
          <section className="dashboard-stats" aria-label="Receive stock summary">
            {cards.map((card) => (
              <article className="dashboard-stat card" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </article>
            ))}
          </section>

          <div className="section-heading">
            <div><p className="eyebrow page">In transit</p><h2>Waiting to be received</h2></div>
            <Truck size={19} aria-hidden="true" />
          </div>

          {payload.incoming.length > 0 && (
            <TableControls tableId="receive-stock-incoming" ariaLabel="Incoming transfers" filterColumns={[{ column: "Status" }]} />
          )}
          <section className="card table-wrap workspace-table" aria-label="Incoming transfers">
            <div className="table-document-heading">
              <strong>{item.title} · waiting</strong>
              <TableDocumentTools tableId="receive-stock-incoming" title={`${item.title} · in transit`} disabled={!payload.incoming.length} />
            </div>
            <table id="receive-stock-incoming">
              <thead>
                <tr>
                  <th>Transfer</th><th>From</th>{staff?.role === "admin" && <th>To</th>}
                  <th>Dispatched</th><th>Lines</th><th>Units</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payload.incoming.length ? payload.incoming.map((transfer) => (
                  <tr key={transfer.id}>
                    <td>
                      <span className="primary-cell mono">{transfer.transfer_number}</span>
                      {transfer.notes && <small className="sales-cell-subtext">{transfer.notes}</small>}
                    </td>
                    <td>{transfer.from_branch_name}</td>
                    {staff?.role === "admin" && <td>{transfer.to_branch_name}</td>}
                    <td className="nowrap">{transfer.dispatched_at ? formatDateTime(transfer.dispatched_at) : "—"}</td>
                    <td>{transfer.item_count}</td>
                    <td>{formatQuantity(transfer.quantity_milli)}</td>
                    <td><span className={`status ${statusTone(transfer.status)}`}>{labelize(transfer.status)}</span></td>
                    <td className="row-actions">
                      <button className="button secondary" type="button" disabled={detailLoading} onClick={() => void openDetail(transfer)}>
                        <Eye size={13} /> Lines
                      </button>
                      {payload.summary.canReceive && (
                        <button className="button secondary" type="button" disabled={detailLoading || actionBusy} onClick={() => void openDetail(transfer)}>
                          Receive
                        </button>
                      )}
                    </td>
                  </tr>
                )) : <tr><td colSpan={staff?.role === "admin" ? 9 : 8} className="empty">Nothing is in transit to this store.</td></tr>}
              </tbody>
            </table>
          </section>

          <div className="section-heading">
            <div><p className="eyebrow page">History</p><h2>Recently received</h2></div>
            <PackageCheck size={19} aria-hidden="true" />
          </div>

          {payload.received.length > 0 && (
            <TableControls tableId="receive-stock-received" ariaLabel="Received transfers" filterColumns={[{ column: "Status" }]} />
          )}
          <section className="card table-wrap workspace-table" aria-label="Recently received transfers">
            <div className="table-document-heading">
              <strong>{item.title} · received</strong>
              <TableDocumentTools tableId="receive-stock-received" title={`${item.title} · received`} disabled={!payload.received.length} />
            </div>
            <table id="receive-stock-received">
              <thead>
                <tr>
                  <th>Transfer</th><th>From</th>{staff?.role === "admin" && <th>To</th>}
                  <th>Received</th><th>Lines</th><th>Units</th><th>Status</th><th>View</th>
                </tr>
              </thead>
              <tbody>
                {payload.received.length ? payload.received.map((transfer) => (
                  <tr key={transfer.id}>
                    <td><span className="primary-cell mono">{transfer.transfer_number}</span></td>
                    <td>{transfer.from_branch_name}</td>
                    {staff?.role === "admin" && <td>{transfer.to_branch_name}</td>}
                    <td className="nowrap">{transfer.received_at ? formatDateTime(transfer.received_at) : "—"}</td>
                    <td>{transfer.item_count}</td>
                    <td>{formatQuantity(transfer.quantity_milli)}</td>
                    <td><span className={`status ${statusTone(transfer.status)}`}>{labelize(transfer.status)}</span></td>
                    <td>
                      <button className="button secondary" type="button" disabled={detailLoading} onClick={() => void openDetail(transfer)}>
                        <Eye size={13} /> Lines
                      </button>
                    </td>
                  </tr>
                )) : <tr><td colSpan={staff?.role === "admin" ? 8 : 7} className="empty">No incoming transfers have been received yet.</td></tr>}
              </tbody>
            </table>
          </section>

          {detail && (
            <section className="card table-wrap workspace-table" aria-label="Transfer lines">
              <div className="table-document-heading">
                <strong>{detail.transfer.transfer_number} · {detail.transfer.from_branch_name} → {detail.transfer.to_branch_name}</strong>
                <button className="button secondary" type="button" onClick={() => setDetail(null)} disabled={actionBusy}><X size={13} /> Close</button>
              </div>
              {receiptCounts && detail.transfer.status === "dispatched" && payload.summary.canReceive && (
                <section className="dashboard-stats" aria-label="Receipt count summary">
                  <article className="dashboard-stat card"><span>Lines</span><strong>{receiptCounts.lines}</strong></article>
                  <article className="dashboard-stat card"><span>Expected units</span><strong>{formatQuantity(receiptCounts.expected)}</strong></article>
                  <article className="dashboard-stat card"><span>Counting</span><strong>{formatQuantity(receiptCounts.counting)}</strong></article>
                  <article className="dashboard-stat card"><span>Short lines</span><strong>{receiptCounts.shortLines}</strong></article>
                </section>
              )}
              <table id="receive-stock-lines">
                <thead><tr><th>Product</th><th>Unit</th><th>Dispatched</th><th>Received</th><th>Cost</th></tr></thead>
                <tbody>
                  {detail.items.length ? detail.items.map((line) => (
                    <tr key={line.id}>
                      <td><span className="primary-cell">{line.product_name}</span></td>
                      <td>{line.unit_code}</td>
                      <td>{formatQuantity(line.quantity_milli)}</td>
                      <td>{formatQuantity(line.received_quantity_milli)}</td>
                      <td>{formatMoney(line.unit_cost_paisa)}</td>
                    </tr>
                  )) : <tr><td colSpan={5} className="empty">This transfer has no line items.</td></tr>}
                </tbody>
              </table>
              {payload.summary.canReceive && detail.transfer.status === "dispatched" && (
                <form className="workspace-form" onSubmit={confirmReceipt}>
                  <h3>Confirm received quantities</h3>
                  <p>Enter what actually arrived. Enter 0 for any missing line.</p>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Product</th><th>Sent</th><th>Received</th></tr></thead>
                      <tbody>
                        {detail.items.map((line) => (
                          <tr key={line.id}>
                            <td>{line.product_name} <small>{line.unit_code}</small></td>
                            <td>{formatQuantity(line.quantity_milli)} {line.unit_code}</td>
                            <td>
                              <input
                                aria-label={`Received quantity for ${line.product_name}`}
                                inputMode="decimal"
                                required
                                value={receiveQuantities[line.id] || ""}
                                onChange={(event) => setReceiveQuantities((values) => ({ ...values, [line.id]: event.target.value }))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="workspace-form-actions">
                    <button className="primary-button" disabled={actionBusy || !detail.items.length} type="submit">
                      {actionBusy ? <LoaderCircle size={14} className="spin" /> : <PackageCheck size={14} />}
                      {actionBusy ? "Receiving…" : "Confirm receipt"}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          <p className="list-limit-note">
            Dispatching is managed by the sending branch. A transfer only increases destination stock after receipt is confirmed.
          </p>
        </>
      )}
    </>
  );
}

export default ReceiveStockWorkspace;
