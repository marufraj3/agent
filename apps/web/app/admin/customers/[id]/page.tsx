"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../../_components/admin-access";
import { ErrorState, LoadingRows, Badge } from "../../_components/ui";
import { adminRequest, useAdminPassword } from "../../_lib/admin-client";
type D = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  platform: string | null;
  platformUserId: string | null;
  language: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  conversations: Array<{
    id: string;
    channel: string;
    status: string;
    lastMessageAt: string;
    _count: { messages: number };
  }>;
  orders: Array<{
    id: string;
    status: string;
    totalAmount: string;
    createdAt: string;
    externalOrderId: string | null;
    items: Array<{ productName: string; variationSize: string }>;
  }>;
  messages: Array<{
    id: string;
    conversationId: string;
    role: string;
    content: string;
    messageType: string;
    createdAt: string;
    metadata?: { productIds?: number[] };
  }>;
  _count: { messages: number; conversations: number; orders: number };
};
export default function Detail() {
  const { id } = useParams<{ id: string }>();
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<D>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        (await adminRequest<{ data: D }>(`/admin/customers/${id}`, password))
          .data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load customer.");
    } finally {
      setLoading(false);
    }
  }, [id, password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <Link
        href="/admin/customers"
        className="text-sm font-semibold text-amber-800"
      >
        ← Customers
      </Link>
      <h1 className="mt-3 text-3xl font-semibold">
        {data?.name ?? "Customer details"}
      </h1>
      <p className="mt-1 break-all font-mono text-xs text-stone-400">{id}</p>
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
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6">
            <Panel title="Profile">
              <Info k="Name" v={data.name} />
              <Info k="Phone" v={data.phone} />
              <Info k="Email" v={data.email} />
              <Info k="Address" v={data.address} />
              <Info
                k="Platform"
                v={`${data.platform ?? "—"} / ${data.platformUserId ?? "—"}`}
              />
              <Info k="Language" v={data.language} />
              <Info
                k="First Seen"
                v={new Date(data.createdAt).toLocaleString()}
              />
              <Info
                k="Last Seen"
                v={new Date(data.updatedAt).toLocaleString()}
              />
            </Panel>
            <Panel title="Metadata">
              <pre className="overflow-auto whitespace-pre-wrap text-xs text-stone-600">
                {JSON.stringify(data.metadata ?? {}, null, 2)}
              </pre>
            </Panel>
          </div>
          <div className="space-y-6 lg:col-span-2">
            <Panel title={`Conversations (${data._count.conversations})`}>
              {data.conversations.map((c) => (
                <Link
                  key={c.id}
                  href={`/admin/inbox?conversation=${c.id}`}
                  className="flex justify-between border-b py-3 last:border-0"
                >
                  <span>
                    <Badge
                      tone={
                        c.status === "HUMAN"
                          ? "amber"
                          : c.status === "CLOSED"
                            ? "stone"
                            : "green"
                      }
                    >
                      {c.status}
                    </Badge>{" "}
                    <span className="ml-2">{c.channel}</span>
                  </span>
                  <small>
                    {c._count.messages} messages ·{" "}
                    {new Date(c.lastMessageAt).toLocaleDateString()}
                  </small>
                </Link>
              ))}
            </Panel>
            <Panel title={`Orders (${data._count.orders})`}>
              {data.orders.length ? (
                data.orders.map((o) => (
                  <Link
                    key={o.id}
                    href={`/admin/orders/${o.id}`}
                    className="flex justify-between border-b py-3 last:border-0"
                  >
                    <span>
                      <strong>{o.externalOrderId ?? o.id.slice(0, 8)}</strong>
                      <small className="block text-stone-500">
                        {o.items
                          .map((i) => `${i.productName} ${i.variationSize}`)
                          .join(", ")}
                      </small>
                    </span>
                    <span className="text-right">
                      ৳{Number(o.totalAmount).toFixed(2)}
                      <small className="block text-stone-500">{o.status}</small>
                    </span>
                  </Link>
                ))
              ) : (
                <p className="text-stone-500">No orders.</p>
              )}
            </Panel>
            <Panel title={`Recent message history (${data._count.messages})`}>
              {data.messages.map((m) => (
                <div key={m.id} className="border-b py-3 last:border-0">
                  <div className="flex justify-between">
                    <Badge
                      tone={
                        m.role === "USER"
                          ? "stone"
                          : m.role === "HUMAN"
                            ? "blue"
                            : "green"
                      }
                    >
                      {m.role}
                    </Badge>
                    <small>{new Date(m.createdAt).toLocaleString()}</small>
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm">{m.content}</p>
                </div>
              ))}
            </Panel>
          </div>
        </div>
      ) : null}
    </main>
  );
}
function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-white p-5">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Info({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="mb-3">
      <p className="text-xs uppercase text-stone-400">{k}</p>
      <p className="break-words text-sm font-medium">{v ?? "—"}</p>
    </div>
  );
}
