"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  Pagination,
  Badge,
} from "../_components/ui";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";
type C = {
  id: string;
  name: string | null;
  phone: string | null;
  platform: string | null;
  platformUserId: string | null;
  updatedAt: string;
  totalSpent: string;
  _count: { conversations: number; orders: number; messages: number };
};
export default function Customers() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<C[]>([]);
  const [searchInput, setSearchInput] = useState("");
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
      if (search) q.set("search", search);
      const r = await adminRequest<{ data: { items: C[]; pages: number } }>(
        `/admin/customers?${q}`,
        password,
      );
      setItems(r.data.items);
      setPages(r.data.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load customers.");
    } finally {
      setLoading(false);
    }
  }, [password, page, search]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">Customers</h1>
      <p className="mt-1 text-stone-600">
        Customer activity, conversations and order value.
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
          placeholder="Name, phone or platform user ID"
          className="min-w-0 flex-1 rounded-xl border bg-white px-4 py-2.5"
        />
        <button className="rounded-xl bg-stone-900 px-5 text-white">
          Search
        </button>
      </form>
      {error ? (
        <div className="mt-5">
          <ErrorState message={error} retry={() => void load()} />
        </div>
      ) : null}
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full min-w-[850px] text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              {[
                "Name",
                "Phone",
                "Platform",
                "Conversations",
                "Orders",
                "Total Spent",
                "Last Activity",
                "Status",
              ].map((x) => (
                <th key={x} className="p-4">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="p-4">
                  <Link
                    href={`/admin/customers/${c.id}`}
                    className="font-semibold text-amber-800 hover:underline"
                  >
                    {c.name ?? "Unnamed"}
                  </Link>
                </td>
                <td className="p-4">{c.phone ?? "—"}</td>
                <td className="p-4">{c.platform ?? "—"}</td>
                <td className="p-4">{c._count.conversations}</td>
                <td className="p-4">{c._count.orders}</td>
                <td className="p-4">৳{Number(c.totalSpent).toFixed(2)}</td>
                <td className="p-4">
                  {new Date(c.updatedAt).toLocaleString()}
                </td>
                <td className="p-4">
                  <Badge tone="green">Active</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingRows />
        ) : !items.length ? (
          <EmptyState text="No customers found." />
        ) : null}
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>
    </main>
  );
}
