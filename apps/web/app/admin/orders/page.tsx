"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingRows,
  Pagination,
} from "../_components/ui";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";
type O = {
  id: string;
  orderCode: string | null;
  status: string;
  confirmationStatus: string;
  source: string;
  totalQuantity: number;
  subtotal: string;
  deliveryCharge: string;
  totalAmount: string;
  externalOrderId: string | null;
  createdAt: string;
  customerSnapshot: { name?: string; phone?: string };
  customer?: { name: string | null; phone: string | null };
  items: Array<unknown>;
};
const statuses: Array<[string, string]> = [
  ["", "All"],
  ["DRAFT", "Draft"],
  ["AWAITING_INFORMATION", "Awaiting Information"],
  ["AWAITING_CONFIRMATION", "Awaiting Confirmation"],
  ["CONFIRMED", "Confirmed"],
  ["SUBMITTED", "Submitted"],
  ["COMPLETED", "Completed"],
  ["CANCELLED", "Cancelled"],
  ["FAILED", "Failed"],
];
export default function Orders() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<O[]>([]);
  const [status, setStatus] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState<Array<{status:string;count:number;totalAmount:string|null}>>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({ page: String(page), limit: "25" });
      if (status) q.set("status", status);
      if (search) q.set("search", search);
      if (source) q.set("source", source);
      if (from) q.set("from", new Date(`${from}T00:00:00+06:00`).toISOString());
      if (to) q.set("to", new Date(`${to}T23:59:59+06:00`).toISOString());
      const r = await adminRequest<{
        data: O[];
        summary: Array<{status:string;count:number;totalAmount:string|null}>;
        pagination: { pages: number };
      }>(`/admin/orders?${q}`, password);
      setItems(r.data);
      setSummary(r.summary);
      setPages(r.pagination.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load orders.");
    } finally {
      setLoading(false);
    }
  }, [password, status, search, source, from, to, page]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-[1500px] px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">Orders</h1>
      <p className="mt-1 text-stone-600">
        Server-calculated drafts, confirmations and submission outcomes.
      </p>
      <div className="mt-5">
        <AdminAccess
          password={password}
          onPasswordChange={setPassword}
          onLoad={() => void load()}
          loading={loading}
        />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(searchInput.trim());
        }}
        className="mt-5 flex gap-2"
      >
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Order ID, phone or customer name"
          className="min-w-0 flex-1 rounded-xl border bg-white px-4 py-2.5"
        />
        <button className="rounded-xl bg-stone-900 px-5 text-white">
          Search
        </button>
      </form>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <select value={source} onChange={e=>{setSource(e.target.value);setPage(1)}} className="rounded-xl border bg-white px-3 py-2"><option value="">All sources</option><option value="AI">AI</option><option value="HUMAN">Human</option><option value="ADMIN">Admin</option></select>
        <label className="text-xs text-stone-500">From<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPage(1)}} className="mt-1 block w-full rounded-xl border bg-white px-3 py-2 text-sm text-stone-900"/></label>
        <label className="text-xs text-stone-500">To<input type="date" value={to} onChange={e=>{setTo(e.target.value);setPage(1)}} className="mt-1 block w-full rounded-xl border bg-white px-3 py-2 text-sm text-stone-900"/></label>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {statuses.map(([k, l]) => (
          <button
            key={l}
            onClick={() => {
              setStatus(k);
              setPage(1);
            }}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${status === k ? "bg-amber-700 text-white" : "border bg-white"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {summary.length>0?<div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{summary.map(item=><div key={item.status} className="rounded-xl border bg-white p-3"><p className="text-xs text-stone-500">{item.status.replaceAll('_',' ')}</p><b>{item.count}</b><span className="ml-2 text-xs text-stone-500">৳{Number(item.totalAmount??0).toFixed(2)}</span></div>)}</div>:null}
      {error ? (
        <div className="mt-5">
          <ErrorState message={error} retry={() => void load()} />
        </div>
      ) : null}
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              {[
                "Order ID",
                "Customer",
                "Phone",
                "Items",
                "Quantity",
                "Subtotal",
                "Delivery",
                "Total",
                "Status",
                "Confirmation",
                "Source",
                "Created",
              ].map((x) => (
                <th key={x} className="p-4">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="p-4">
                  <Link
                    href={`/admin/orders/${o.id}`}
                    className="font-semibold text-amber-800"
                  >
                    {o.externalOrderId ?? o.orderCode ?? o.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="p-4">
                  {o.customer?.name ?? o.customerSnapshot.name ?? "—"}
                </td>
                <td className="p-4">
                  {o.customer?.phone ?? o.customerSnapshot.phone ?? "—"}
                </td>
                <td className="p-4">{o.items.length}</td>
                <td className="p-4">{o.totalQuantity}</td>
                <td className="p-4">৳{Number(o.subtotal).toFixed(2)}</td>
                <td className="p-4">৳{Number(o.deliveryCharge).toFixed(2)}</td>
                <td className="p-4 font-semibold">
                  ৳{Number(o.totalAmount).toFixed(2)}
                </td>
                <td className="p-4">
                  <Badge
                    tone={
                      o.status === "FAILED"
                        ? "red"
                        : o.status === "COMPLETED" || o.status === "SUBMITTED"
                          ? "green"
                          : "amber"
                    }
                  >
                    {o.status.replaceAll("_", " ")}
                  </Badge>
                </td>
                <td className="p-4">{o.confirmationStatus}</td>
                <td className="p-4">{o.source}</td>
                <td className="p-4">
                  {new Date(o.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingRows />
        ) : !items.length ? (
          <EmptyState text="No orders found." />
        ) : null}
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>
    </main>
  );
}
