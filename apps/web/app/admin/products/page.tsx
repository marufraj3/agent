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
type Product = {
  id: string;
  productName: string;
  productCode: string;
  productImage: string | null;
  categoryName: string | null;
  sellPrice: string;
  discountPrice: string | null;
  totalStock: number;
  isPreOrder: boolean;
  productStatus: string;
  presentInFeed: boolean;
  lastSyncedAt: string | null;
};
const filters: Array<[string, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["inactive", "Inactive"],
  ["preorder", "Pre-order"],
  ["out_of_stock", "Out of stock"],
  ["low_stock", "Low stock"],
];
export default function Products() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<Product[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({
        page: String(page),
        limit: "25",
        filter,
      });
      if (search) q.set("search", search);
      const r = await adminRequest<{
        data: { items: Product[]; pages: number };
      }>(`/admin/products?${q}`, password);
      setItems(r.data.items);
      setPages(r.data.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load products.");
    } finally {
      setLoading(false);
    }
  }, [password, page, filter, search]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">Products</h1>
      <p className="mt-1 text-stone-600">
        Read-only catalogue synchronized from the Product Feed.
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
        className="mt-5 flex flex-wrap gap-2"
      >
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Name, code or category"
          className="min-w-64 flex-1 rounded-xl border bg-white px-4 py-2.5"
        />
        <button className="rounded-xl bg-stone-900 px-5 text-white">
          Search
        </button>
      </form>
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {filters.map(([k, l]) => (
          <button
            key={k}
            onClick={() => {
              setFilter(k);
              setPage(1);
            }}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${filter === k ? "bg-amber-700 text-white" : "border bg-white"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {error ? (
        <div className="mt-5">
          <ErrorState message={error} retry={() => void load()} />
        </div>
      ) : null}
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full min-w-[950px] text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              {[
                "Image",
                "Product",
                "Code",
                "Category",
                "Price",
                "Discount",
                "Stock",
                "Pre-order",
                "Status",
                "Last Sync",
              ].map((x) => (
                <th key={x} className="p-4">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-3">
                  {p.productImage ? (
                    <img
                      src={p.productImage}
                      alt=""
                      className="size-12 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="size-12 rounded-lg bg-stone-100" />
                  )}
                </td>
                <td className="p-4">
                  <Link
                    href={`/admin/products/${p.id}`}
                    className="font-semibold text-amber-800 hover:underline"
                  >
                    {p.productName}
                  </Link>
                </td>
                <td className="p-4 font-mono">{p.productCode}</td>
                <td className="p-4">{p.categoryName ?? "—"}</td>
                <td className="p-4">৳{Number(p.sellPrice).toFixed(2)}</td>
                <td className="p-4">
                  {p.discountPrice
                    ? `৳${Number(p.discountPrice).toFixed(2)}`
                    : "—"}
                </td>
                <td className="p-4">{p.totalStock}</td>
                <td className="p-4">{p.isPreOrder ? "Yes" : "No"}</td>
                <td className="p-4">
                  <Badge tone={p.presentInFeed ? "green" : "red"}>
                    {p.productStatus}
                  </Badge>
                </td>
                <td className="p-4">
                  {p.lastSyncedAt
                    ? new Date(p.lastSyncedAt).toLocaleString()
                    : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingRows />
        ) : !items.length ? (
          <EmptyState text="No products found." />
        ) : null}
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>
    </main>
  );
}
