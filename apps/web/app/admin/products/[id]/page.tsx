"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../../_components/admin-access";
import { ErrorState, LoadingRows, Badge } from "../../_components/ui";
import { adminRequest, useAdminPassword } from "../../_lib/admin-client";
type P = {
  id: string;
  productName: string;
  productCode: string;
  productImage: string | null;
  categoryName: string | null;
  subCategoryName: string | null;
  sellPrice: string;
  discountPrice: string | null;
  flashSellPrice: string | null;
  productStatus: string;
  isPreOrder: boolean;
  presentInFeed: boolean;
  lastSyncedAt: string | null;
  variations: Array<{
    id: string;
    sizeName: string;
    stockQuantity: number;
    active: boolean;
    lastSyncedAt: string | null;
  }>;
};
export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<P>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        (await adminRequest<{ data: P }>(`/admin/products/${id}`, password))
          .data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load product.");
    } finally {
      setLoading(false);
    }
  }, [id, password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <Link
        href="/admin/products"
        className="text-sm font-semibold text-amber-800"
      >
        ← Products
      </Link>
      <h1 className="mt-3 text-3xl font-semibold">Product details</h1>
      <div className="mt-5">
        <AdminAccess
          password={password}
          onPasswordChange={setPassword}
          onLoad={() => void load()}
          loading={loading}
        />
      </div>
      {error ? (
        <div className="mt-5">
          <ErrorState message={error} retry={() => void load()} />
        </div>
      ) : null}
      {loading && !data ? (
        <LoadingRows />
      ) : data ? (
        <>
          <section className="mt-6 grid gap-6 rounded-2xl border bg-white p-6 md:grid-cols-[240px_1fr]">
            {data.productImage ? (
              <img
                src={data.productImage}
                alt={data.productName}
                className="aspect-square w-full rounded-2xl object-cover"
              />
            ) : (
              <div className="aspect-square rounded-2xl bg-stone-100" />
            )}
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={data.presentInFeed ? "green" : "red"}>
                  {data.productStatus}
                </Badge>
                {data.isPreOrder ? <Badge tone="amber">Pre-order</Badge> : null}
              </div>
              <h2 className="mt-3 text-2xl font-semibold">
                {data.productName}
              </h2>
              <p className="mt-1 font-mono text-stone-500">
                {data.productCode}
              </p>
              <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                <Item k="Category" v={data.categoryName ?? "—"} />
                <Item k="Subcategory" v={data.subCategoryName ?? "—"} />
                <Item k="Price" v={`৳${Number(data.sellPrice).toFixed(2)}`} />
                <Item
                  k="Discount"
                  v={
                    data.discountPrice
                      ? `৳${Number(data.discountPrice).toFixed(2)}`
                      : "—"
                  }
                />
                <Item
                  k="Last sync"
                  v={
                    data.lastSyncedAt
                      ? new Date(data.lastSyncedAt).toLocaleString()
                      : "Never"
                  }
                />
              </dl>
            </div>
          </section>
          <section className="mt-6 overflow-hidden rounded-2xl border bg-white">
            <h2 className="p-5 text-lg font-semibold">Sizes and stock</h2>
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-stone-500">
                <tr>
                  <th className="p-4">Size</th>
                  <th className="p-4">Stock</th>
                  <th className="p-4">Active</th>
                  <th className="p-4">Last Sync</th>
                </tr>
              </thead>
              <tbody>
                {data.variations.map((v) => (
                  <tr key={v.id} className="border-t">
                    <td className="p-4 font-semibold">{v.sizeName}</td>
                    <td className="p-4">{v.stockQuantity}</td>
                    <td className="p-4">{v.active ? "Yes" : "No"}</td>
                    <td className="p-4">
                      {v.lastSyncedAt
                        ? new Date(v.lastSyncedAt).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </main>
  );
}
function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-stone-400">{k}</dt>
      <dd className="mt-1 font-medium">{v}</dd>
    </div>
  );
}
