"use client";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "./_components/admin-access";
import { Badge, ErrorState, LoadingRows } from "./_components/ui";
import { adminRequest, useAdminPassword } from "./_lib/admin-client";
type Data = {
  range: { from: string; to: string };
  today: Record<string, number>;
  system: Record<string, string>;
  productSync: {
    lastSync: { createdAt: string } | null;
    products: number;
    variations: number;
    status: string;
  };
  ai: {
    requests: number;
    failures: number;
    fallbacks: number;
    averageResponseTimeMs: number;
  };
  orders: Record<string, number>;
  automation: { pendingFollowUps: number; sentToday: number; cancelled: number; failed: number; abandonedOrders: number };
  queues: Array<{name:string;paused:boolean;counts:Record<string,number>}>;
  unresolvedAlerts: number;
};
const ranges = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 Days"],
  ["30d", "Last 30 Days"],
  ["custom", "Custom"],
] as const;
export default function Dashboard() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<Data>();
  const [range, setRange] = useState("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ range });
      if (range === "custom") {
        if (!from || !to) {
          setLoading(false);
          return;
        }
        p.set("from", new Date(`${from}T00:00:00+06:00`).toISOString());
        p.set("to", new Date(`${to}T23:59:59+06:00`).toISOString());
      }
      setData(
        (await adminRequest<{ data: Data }>(`/admin/dashboard?${p}`, password))
          .data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load dashboard.");
    } finally {
      setLoading(false);
    }
  }, [password, range, from, to]);
  useEffect(() => {
    if (!hydrated || !password) return;
    void load();
    if (range === 'custom') return;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [hydrated, password, range, load]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-7 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-amber-700">
            Operations overview
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Dashboard</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {ranges.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`rounded-full px-3 py-2 text-xs font-semibold ${range === k ? "bg-stone-900 text-white" : "border bg-white"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {range === "custom" ? (
        <div className="mt-4 flex gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-xl border px-3 py-2"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-xl border px-3 py-2"
          />
          <button
            onClick={() => void load()}
            className="rounded-xl bg-stone-900 px-4 text-white"
          >
            Apply
          </button>
        </div>
      ) : null}
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
      {loading && !data ? <LoadingRows /> : null}
      {data ? (
        <div className="mt-6 space-y-7">
          <Section title="Selected period">
            <Cards
              values={[
                ["AI Conversations", data.today.conversations ?? 0],
                ["Messenger Messages", data.today.messengerMessages ?? 0],
                ["Orders", data.today.orders ?? 0],
                ["Confirmed Orders", data.today.confirmedOrders ?? 0],
                ["Human Handover", data.today.handovers ?? 0],
              ]}
            />
          </Section>
          <Section title="System Status">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
              {Object.entries(data.system).map(([k, v]) => (
                <div key={k} className="rounded-2xl border bg-white p-4">
                  <p className="text-xs uppercase text-stone-400">{label(k)}</p>
                  <div className="mt-3">
                    <Badge
                      tone={
                        ["up", "ready", "connected", "closed"].includes(v)
                          ? "green"
                          : v === "not_configured"
                            ? "amber"
                            : "red"
                      }
                    >
                      {v.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </Section>
          <Section title={`Queue Operations · ${data.unresolvedAlerts} unresolved alert${data.unresolvedAlerts===1?'':'s'}`}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.queues.map(q=><div key={q.name} className="rounded-2xl border bg-white p-4"><div className="flex justify-between"><b>{q.name}</b><Badge tone={q.paused?'amber':'green'}>{q.paused?'paused':'active'}</Badge></div><p className="mt-2 text-xs text-stone-600">{Object.entries(q.counts).map(([k,v])=>`${k}: ${v}`).join(' · ')}</p></div>)}</div>
          </Section>
          <div className="grid gap-7 xl:grid-cols-2">
            <Section title="Product Sync">
              <Cards
                values={[
                  [
                    "Last Sync",
                    data.productSync.lastSync
                      ? new Date(
                          data.productSync.lastSync.createdAt,
                        ).toLocaleString()
                      : "Never",
                  ],
                  ["Products", data.productSync.products],
                  ["Variations", data.productSync.variations],
                  ["Sync Status", data.productSync.status],
                ]}
              />
            </Section>
            <Section title="AI Statistics">
              <Cards
                values={[
                  ["AI Requests", data.ai.requests],
                  ["AI Failures", data.ai.failures],
                  ["Fallbacks", data.ai.fallbacks],
                  ["Average Response", `${data.ai.averageResponseTimeMs} ms`],
                ]}
              />
            </Section>
          </div>
          <Section title="Automation">
            <Cards values={[["Pending Follow-ups",data.automation.pendingFollowUps],["Sent Today",data.automation.sentToday],["Cancelled",data.automation.cancelled],["Failed",data.automation.failed],["Abandoned Orders",data.automation.abandonedOrders]]}/>
          </Section>
          <Section title="Order Statistics">
            <Cards
              values={Object.entries(data.orders).map(([k, v]) => [
                label(k),
                v,
              ])}
            />
          </Section>
        </div>
      ) : null}
    </main>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Cards({ values }: { values: Array<[string, string | number]> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
      {values.map(([a, b]) => (
        <div key={a} className="rounded-2xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
            {a}
          </p>
          <p className="mt-2 text-2xl font-semibold">{b}</p>
        </div>
      ))}
    </div>
  );
}
function label(v: string) {
  return v.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase());
}
