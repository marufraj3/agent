"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import { Badge, ErrorState, LoadingRows } from "../_components/ui";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";
type Q = { name: string; available: boolean; counts: Record<string, number> };
type H = {
  status: string;
  database: string;
  redis: string;
  queues: Q[];
  workers: Array<{ name: string; heartbeat: string | null }>;
  circuits: Array<{ service: string; state: string; failures: number }>;
  latestProductSync: { createdAt: string } | null;
  productMetrics: { available: number; stale: number } | null;
  uptimeSeconds: number;
};
export default function System() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<H>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        (await adminRequest<{ data: H }>("/admin/system/health", password))
          .data,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load system health.",
      );
    } finally {
      setLoading(false);
    }
  }, [password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">System</h1>
      <div className="mt-4 flex gap-2">
        <Tab href="/admin/system" label="Health" active />
        <Tab href="/admin/system#queues" label="Queues" />
        <Tab href="/admin/system/jobs" label="Jobs" />
        <Tab href="/admin/system/logs" label="Logs" />
      </div>
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
          <section className="mt-6 grid gap-3 sm:grid-cols-3">
            <Card k="API" v={data.status} />
            <Card k="Database" v={data.database} />
            <Card k="Redis" v={data.redis} />
          </section>
          <section className="mt-7">
            <h2 className="mb-3 text-xl font-semibold">Workers & circuits</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.workers.map((w) => (
                <Card
                  key={w.name}
                  k={w.name}
                  v={
                    w.heartbeat
                      ? `Active · ${new Date(w.heartbeat).toLocaleTimeString()}`
                      : "No heartbeat"
                  }
                />
              ))}
              {data.circuits.map((c) => (
                <Card
                  key={c.service}
                  k={`${c.service} circuit`}
                  v={`${c.state} · ${c.failures} failures`}
                />
              ))}
            </div>
          </section>
          <section id="queues" className="mt-7 scroll-mt-4">
            <h2 className="mb-3 text-xl font-semibold">Queues</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.queues.map((q) => (
                <div key={q.name} className="rounded-2xl border bg-white p-5">
                  <div className="flex justify-between">
                    <strong>{q.name}</strong>
                    <Badge tone={q.available ? "green" : "red"}>
                      {q.available ? "Available" : "Unavailable"}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm text-stone-600">
                    {Object.entries(q.counts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ") || "No counts"}
                  </p>
                </div>
              ))}
            </div>
          </section>
          <section className="mt-7 rounded-2xl border bg-white p-5">
            <h2 className="text-lg font-semibold">Product sync</h2>
            <p className="mt-2 text-sm">
              Last sync:{" "}
              {data.latestProductSync
                ? new Date(data.latestProductSync.createdAt).toLocaleString()
                : "Never"}{" "}
              · Available products: {data.productMetrics?.available ?? "—"} ·
              Stale: {data.productMetrics?.stale ?? "—"}
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
function Tab({
  href,
  label,
  active = false,
}: {
  href: string;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-4 py-2 text-sm font-semibold ${active ? "bg-stone-900 text-white" : "border bg-white"}`}
    >
      {label}
    </Link>
  );
}
function Card({ k, v }: { k: string; v: string }) {
  const good = /up|ok|active|closed/i.test(v);
  return (
    <div className="rounded-2xl border bg-white p-5">
      <p className="text-xs uppercase text-stone-400">{k}</p>
      <div className="mt-2">
        <Badge tone={good ? "green" : "amber"}>{v}</Badge>
      </div>
    </div>
  );
}
