"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../../_components/admin-access";
import { Badge, ErrorState, Toast } from "../../_components/ui";
import { adminRequest, useAdminPassword } from "../../_lib/admin-client";
type S = {
  connected: boolean;
  connectionStatus: string;
  pageId: string | null;
  pageName: string | null;
  tokenMasked: string | null;
  tokenLastCheckedAt: string | null;
  aiEnabled: boolean;
  testMode: boolean;
  openAlerts: number;
  webhookUrl: string;
  graphApiVersion: string;
  webhookConfigured: boolean;
  lastWebhookAt: string | null;
  lastOutboundMessageAt: string | null;
  lastError: string | null;
};
export default function Facebook() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<S>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        (await adminRequest<{ data: S }>("/admin/settings/facebook", password))
          .data,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load Facebook status.",
      );
    } finally {
      setLoading(false);
    }
  }, [password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  async function test() {
    setLoading(true);
    try {
      const r = await adminRequest<{ message: string }>(
        "/admin/settings/facebook/test",
        password,
        { method: "POST" },
      );
      setToast(r.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection test failed.");
    } finally {
      setLoading(false);
    }
  }
  async function toggleAi() {
    if (!data?.pageId) return;
    await adminRequest("/admin/settings/facebook", password, { method: "PATCH", body: JSON.stringify({ pageId: data.pageId, aiEnabled: !data.aiEnabled }) });
    setToast(`AI agent ${data.aiEnabled ? "paused" : "enabled"}.`); await load();
  }
  async function setEmergency(enabled: boolean) {
    if (enabled && !window.confirm("Stop all queued and future automated Messenger responses? Incoming messages will still be stored.")) return;
    await adminRequest("/admin/settings/facebook/emergency-stop", password, { method: "POST", body: JSON.stringify({ enabled }) });
    setToast(enabled ? "Emergency stop enabled." : "Emergency stop released.");
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
      <Link
        href="/admin/settings"
        className="text-sm font-semibold text-amber-800"
      >
        ← Settings
      </Link>
      <h1 className="mt-3 text-3xl font-semibold">Facebook Integration</h1>
      <p className="mt-1 text-stone-600">
        Connection status only. Tokens and secrets are never displayed.
      </p>
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
      {data ? (
        <section className="mt-6 rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Connection</h2>
            <Badge tone={data.connected ? "green" : "red"}>
              {data.connected ? "Connected" : "Not Connected"}
            </Badge>
          </div>
          <dl className="mt-6 grid gap-5 sm:grid-cols-2">
            <Info k="Page ID" v={data.pageId ?? "Not configured"} />
            <Info k="Page Name" v={data.pageName ?? "Unknown"} />
            <Info k="Token" v={data.tokenMasked ?? "Not configured"} />
            <Info k="AI Agent" v={data.aiEnabled ? "ON" : "OFF"} />
            <Info k="Webhook URL" v={data.webhookUrl} />
            <Info
              k="Webhook Status"
              v={data.webhookConfigured ? "Configured" : "Not configured"}
            />
            <Info k="Graph API" v={data.graphApiVersion} />
            <Info
              k="Last Event"
              v={
                data.lastWebhookAt
                  ? new Date(data.lastWebhookAt).toLocaleString()
                  : "None"
              }
            />
            <Info
              k="Last Successful Message"
              v={
                data.lastOutboundMessageAt
                  ? new Date(data.lastOutboundMessageAt).toLocaleString()
                  : "None"
              }
            />
            <Info k="Last Error" v={data.lastError ?? "None"} />
          </dl>
          <div className="mt-6 flex gap-2">
            <button
              onClick={() => void test()}
              disabled={loading}
              className="rounded-xl bg-blue-700 px-4 py-2 font-semibold text-white"
            >
              Test Connection
            </button>
            <button onClick={() => void toggleAi()} disabled={loading || !data.pageId} className="rounded-xl border px-4 py-2 font-semibold">{data.aiEnabled ? "Pause AI" : "Enable AI"}</button>
            <button onClick={() => void setEmergency(true)} className="rounded-xl bg-red-700 px-4 py-2 font-semibold text-white">Emergency Stop AI</button>
            <button onClick={() => void setEmergency(false)} className="rounded-xl border px-4 py-2 font-semibold">Release Stop</button>
            <Link href="/admin/system/messenger-health" className="rounded-xl border px-4 py-2 font-semibold">Health</Link>
            <Link href="/admin/messenger/failed" className="rounded-xl border px-4 py-2 font-semibold">Failed Messages</Link>
            <button onClick={() => void load()} disabled={loading} className="rounded-xl border px-4 py-2 font-semibold">Refresh Status</button>
          </div>
        </section>
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </main>
  );
}
function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-stone-400">{k}</dt>
      <dd className="mt-1 font-medium">{v}</dd>
    </div>
  );
}
