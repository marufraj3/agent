"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import { ConfirmModal, ErrorState, Toast, Badge } from "../_components/ui";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";
type Settings = {
  deliveryChargeDhaka: string;
  deliveryChargeOutsideDhaka: string;
  returnDeliveryCharge: string;
  websiteApiBaseUrl: string;
  pageId: string;
  deliveryCompanyId: string;
  utmSource: string;
  utmCampaign: string;
};
type AI = {
  model: string;
  maxOutput: number;
  temperature: number;
  timeoutMs: number;
  historyLimit: number;
  apiKey: { configured: boolean };
  source: string;
  editable: boolean;
};
type Q = {
  id: string;
  title: string;
  message: string;
  enabled: boolean;
  sortOrder: number;
};
const initial: Settings = {
  deliveryChargeDhaka: "0",
  deliveryChargeOutsideDhaka: "0",
  returnDeliveryCharge: "0",
  websiteApiBaseUrl: "",
  pageId: "",
  deliveryCompanyId: "",
  utmSource: "",
  utmCampaign: "",
};
export default function SettingsPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [settings, setSettings] = useState(initial);
  const [ai, setAi] = useState<AI>();
  const [replies, setReplies] = useState<Q[]>([]);
  const [editing, setEditing] = useState<Partial<Q>>({
    title: "",
    message: "",
    enabled: true,
    sortOrder: 0,
  });
  const [deleteId, setDeleteId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const [s, a, q] = await Promise.all([
        adminRequest<{ data: Settings }>("/admin/settings", password),
        adminRequest<{ data: AI }>("/admin/settings/ai", password),
        adminRequest<{ data: Q[] }>(
          "/admin/quick-replies?includeDisabled=true",
          password,
        ),
      ]);
      setSettings(s.data);
      setAi(a.data);
      setReplies(q.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load settings.");
    } finally {
      setLoading(false);
    }
  }, [password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  async function save(body: Partial<Settings>) {
    setLoading(true);
    try {
      const r = await adminRequest<{ data: Settings; message: string }>(
        "/admin/settings",
        password,
        { method: "PUT", body: JSON.stringify(body) },
      );
      setSettings(r.data);
      setToast(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setLoading(false);
    }
  }
  async function saveReply() {
    if (!editing.title?.trim() || !editing.message?.trim()) return;
    const id = editing.id;
    try {
      await adminRequest(
        id ? `/admin/quick-replies/${id}` : "/admin/quick-replies",
        password,
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify({
            title: editing.title,
            message: editing.message,
            enabled: editing.enabled ?? true,
            sortOrder: Number(editing.sortOrder) || 0,
          }),
        },
      );
      setEditing({ title: "", message: "", enabled: true, sortOrder: 0 });
      setToast(id ? "Quick reply updated" : "Quick reply created");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quick reply save failed.");
    }
  }
  async function remove() {
    try {
      await adminRequest(`/admin/quick-replies/${deleteId}`, password, {
        method: "DELETE",
      });
      setDeleteId("");
      setToast("Quick reply deleted");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    }
  }
  function set<K extends keyof Settings>(k: K, v: string) {
    setSettings((x) => ({ ...x, [k]: v }));
  }
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Settings</h1>
          <p className="mt-1 text-stone-600">
            Business, quick reply and safe AI configuration.
          </p>
        </div>
        <Link
          href="/admin/settings/facebook"
          className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Facebook connection
        </Link>
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
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Section title="Delivery">
          <Field
            label="Dhaka Delivery Charge"
            value={settings.deliveryChargeDhaka}
            onChange={(v) => set("deliveryChargeDhaka", v)}
          />
          <Field
            label="Outside Dhaka Delivery Charge"
            value={settings.deliveryChargeOutsideDhaka}
            onChange={(v) => set("deliveryChargeOutsideDhaka", v)}
          />
          <Field
            label="Return Delivery Charge"
            value={settings.returnDeliveryCharge}
            onChange={(v) => set("returnDeliveryCharge", v)}
          />
          <button
            onClick={() =>
              void save({
                deliveryChargeDhaka: settings.deliveryChargeDhaka,
                deliveryChargeOutsideDhaka: settings.deliveryChargeOutsideDhaka,
                returnDeliveryCharge: settings.returnDeliveryCharge,
              })
            }
            className="mt-4 rounded-xl bg-amber-700 px-4 py-2 font-semibold text-white"
          >
            Save delivery
          </button>
        </Section>
        <Section title="Order API">
          <Field
            label="Website API Base"
            value={settings.websiteApiBaseUrl}
            onChange={(v) => set("websiteApiBaseUrl", v)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Page ID"
              value={settings.pageId}
              onChange={(v) => set("pageId", v)}
            />
            <Field
              label="Delivery Company ID"
              value={settings.deliveryCompanyId}
              onChange={(v) => set("deliveryCompanyId", v)}
            />
          </div>
          <Field
            label="UTM Source"
            value={settings.utmSource}
            onChange={(v) => set("utmSource", v)}
          />
          <Field
            label="UTM Campaign"
            value={settings.utmCampaign}
            onChange={(v) => set("utmCampaign", v)}
          />
          <button
            onClick={() =>
              void save({
                websiteApiBaseUrl: settings.websiteApiBaseUrl,
                pageId: settings.pageId,
                deliveryCompanyId: settings.deliveryCompanyId,
                utmSource: settings.utmSource,
                utmCampaign: settings.utmCampaign,
              })
            }
            className="mt-4 rounded-xl bg-stone-900 px-4 py-2 font-semibold text-white"
          >
            Save Order API
          </button>
          <p className="mt-3 text-xs text-stone-500">
            Secrets remain environment-controlled and are never returned.
          </p>
        </Section>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Section title="Quick Replies">
          <div className="space-y-3">
            {replies.map((q) => (
              <div key={q.id} className="rounded-xl border p-3">
                <div className="flex justify-between">
                  <strong>{q.title}</strong>
                  <Badge tone={q.enabled ? "green" : "stone"}>
                    {q.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-stone-600">{q.message}</p>
                <div className="mt-2 flex gap-3">
                  <button
                    onClick={() => setEditing(q)}
                    className="text-sm font-semibold text-amber-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteId(q.id)}
                    className="text-sm font-semibold text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 border-t pt-5">
            <Field
              label="Title"
              value={editing.title ?? ""}
              onChange={(v) => setEditing((x) => ({ ...x, title: v }))}
            />
            <label className="mt-3 block text-sm font-medium">
              Message
              <textarea
                value={editing.message ?? ""}
                onChange={(e) =>
                  setEditing((x) => ({ ...x, message: e.target.value }))
                }
                maxLength={4000}
                className="mt-1 min-h-24 w-full rounded-xl border p-3"
              />
            </label>
            <label className="mt-3 flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.enabled ?? true}
                onChange={(e) =>
                  setEditing((x) => ({ ...x, enabled: e.target.checked }))
                }
              />{" "}
              Enabled
            </label>
            <button
              onClick={() => void saveReply()}
              className="mt-3 rounded-xl bg-blue-700 px-4 py-2 font-semibold text-white"
            >
              {editing.id ? "Update" : "Create"} quick reply
            </button>
          </div>
        </Section>
        <Section title="AI Configuration">
          {ai ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              <Info k="Model" v={ai.model} />
              <Info k="Max output" v={String(ai.maxOutput)} />
              <Info k="Temperature" v={String(ai.temperature)} />
              <Info k="Timeout" v={`${ai.timeoutMs} ms`} />
              <Info k="History limit" v={String(ai.historyLimit)} />
              <Info
                k="API key"
                v={
                  ai.apiKey.configured
                    ? "Configured ••••••••"
                    : "Not configured"
                }
              />
            </dl>
          ) : (
            <p>Load settings to view.</p>
          )}
          <p className="mt-5 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            AI runtime limits are controlled by server environment variables and
            are read-only here. They cannot bypass safety or business rules.
          </p>
        </Section>
      </div>
      {deleteId ? (
        <ConfirmModal
          title="Delete Quick Reply?"
          description="This action permanently removes the reply from the inbox picker."
          confirmLabel="Delete"
          onConfirm={() => void remove()}
          onCancel={() => setDeleteId("")}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
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
    <section className="rounded-2xl border bg-white p-6">
      <h2 className="mb-5 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mb-3 block text-sm font-medium">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border bg-stone-50 px-3 py-2.5"
      />
    </label>
  );
}
function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-stone-400">{k}</dt>
      <dd className="mt-1 font-semibold">{v}</dd>
    </div>
  );
}
