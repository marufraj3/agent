"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../../_components/admin-access";
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingRows,
  Pagination,
} from "../../_components/ui";
import { adminRequest, useAdminPassword } from "../../_lib/admin-client";
type L = {
  id: string;
  createdAt: string;
  level: string;
  module: string | null;
  event: string | null;
  type: string;
  message: string;
  requestId: string | null;
  conversationId: string | null;
  customerId: string | null;
  status: string | null;
};
const filters = [
  "all",
  "info",
  "warning",
  "error",
  "ai",
  "messenger",
  "orders",
  "products",
  "system",
];
export default function Logs() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<L[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
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
      if (filter !== "all") q.set("filter", filter);
      if (search) q.set("search", search);
      const r = await adminRequest<{ data: { items: L[]; pages: number } }>(
        `/admin/system/logs?${q}`,
        password,
      );
      setItems(r.data.items);
      setPages(r.data.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load logs.");
    } finally {
      setLoading(false);
    }
  }, [password, page, filter, search]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-[1500px] px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">System Logs</h1>
      <div className="mt-4 flex gap-2">
        <Link
          href="/admin/system"
          className="rounded-full border bg-white px-4 py-2 text-sm"
        >
          Health
        </Link>
        <Link
          href="/admin/system/jobs"
          className="rounded-full border bg-white px-4 py-2 text-sm"
        >
          Jobs
        </Link>
        <span className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white">
          Logs
        </span>
      </div>
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
          void load();
        }}
        className="mt-5 flex gap-2"
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Request ID or event"
          className="flex-1 rounded-xl border bg-white px-4 py-2"
        />
        <button className="rounded-xl bg-stone-900 px-4 text-white">
          Search
        </button>
      </form>
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${filter === f ? "bg-amber-700 text-white" : "border bg-white"}`}
          >
            {f}
          </button>
        ))}
      </div>
      {error ? (
        <div className="mt-5">
          <ErrorState message={error} retry={() => void load()} />
        </div>
      ) : null}
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              {[
                "Time",
                "Level",
                "Module",
                "Event",
                "Request ID",
                "Conversation ID",
                "Customer",
                "Status",
              ].map((x) => (
                <th key={x} className="p-4">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="p-4">
                  {new Date(l.createdAt).toLocaleString()}
                </td>
                <td className="p-4">
                  <Badge
                    tone={
                      l.level === "ERROR"
                        ? "red"
                        : l.level === "WARN"
                          ? "amber"
                          : "green"
                    }
                  >
                    {l.level}
                  </Badge>
                </td>
                <td className="p-4">{l.module ?? "system"}</td>
                <td className="p-4">
                  <strong>{l.event ?? l.type}</strong>
                  <p className="max-w-72 truncate text-xs text-stone-500">
                    {l.message}
                  </p>
                </td>
                <td className="p-4 font-mono text-xs">{l.requestId ?? "—"}</td>
                <td className="p-4 font-mono text-xs">
                  {l.conversationId ?? "—"}
                </td>
                <td className="p-4 font-mono text-xs">{l.customerId ?? "—"}</td>
                <td className="p-4">{l.status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingRows />
        ) : !items.length ? (
          <EmptyState text="No logs found." />
        ) : null}
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>
    </main>
  );
}
