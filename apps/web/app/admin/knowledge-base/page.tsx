"use client";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import {
  ConfirmModal,
  ErrorState,
  LoadingRows,
  Toast,
} from "../_components/ui";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";
type KB = { content: string; version: number; updatedAt: string };
type V = {
  id: string;
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
export default function Knowledge() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<KB>();
  const [content, setContent] = useState("");
  const [versions, setVersions] = useState<V[]>([]);
  const [restore, setRestore] = useState<number>();
  const [preview, setPreview] = useState<KB>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const [a, v] = await Promise.all([
        adminRequest<{ data: KB | null }>("/admin/knowledge-base", password),
        adminRequest<{ data: { items: V[] } }>(
          "/admin/knowledge-base/versions?limit=20",
          password,
        ),
      ]);
      if (a.data) {
        setData(a.data);
        setContent(a.data.content);
      }
      setVersions(v.data.items);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load knowledge base.",
      );
    } finally {
      setLoading(false);
    }
  }, [password]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  async function save() {
    if (!content.trim()) return;
    setLoading(true);
    try {
      const r = await adminRequest<{ data: KB; message: string }>(
        "/admin/knowledge-base",
        password,
        { method: "PUT", body: JSON.stringify({ content }) },
      );
      setData(r.data);
      setToast(r.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setLoading(false);
    }
  }
  async function doRestore() {
    if (!restore) return;
    setLoading(true);
    try {
      const r = await adminRequest<{ message: string }>(
        `/admin/knowledge-base/versions/${restore}/restore`,
        password,
        { method: "POST" },
      );
      setToast(r.message);
      setRestore(undefined);
      setPreview(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
    } finally {
      setLoading(false);
    }
  }
  async function view(version: number) {
    try {
      setPreview(
        (
          await adminRequest<{ data: KB }>(
            `/admin/knowledge-base/versions/${version}`,
            password,
          )
        ).data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load version.");
    }
  }
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">Knowledge Base</h1>
      <p className="mt-1 text-stone-600">
        One authoritative editor for persona, language, sales, product, order,
        delivery, return, handling, handover and FAQ rules.
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
      {loading && !data ? (
        <LoadingRows />
      ) : (
        <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_330px]">
          <section className="rounded-2xl border bg-white p-5">
            <div className="mb-3 flex justify-between text-xs text-stone-500">
              <span>
                Version {data?.version ?? "—"} ·{" "}
                {data ? new Date(data.updatedAt).toLocaleString() : "Never"}
              </span>
              <span>{content.length.toLocaleString()} / 100,000</span>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={100000}
              className="min-h-[620px] w-full resize-y rounded-xl border bg-stone-50 p-5 font-mono text-sm leading-7 outline-none focus:border-amber-700"
              placeholder={
                "Business Information\n\nAI Persona\n\nLanguage Rules\n\nSales Rules\n\nProduct Rules\n\nOrder Rules\n\nDelivery Rules\n\nReturn Rules\n\nCustomer Handling\n\nHuman Handover Rules\n\nForbidden Claims\n\nFAQ"
              }
            />
            <div className="mt-4 text-right">
              <button
                onClick={() => void save()}
                disabled={loading || !content.trim()}
                className="rounded-xl bg-amber-700 px-6 py-3 font-semibold text-white disabled:opacity-40"
              >
                Save new version
              </button>
            </div>
          </section>
          <aside className="rounded-2xl border bg-white p-5">
            <h2 className="text-lg font-semibold">Version history</h2>
            <p className="mt-1 text-xs text-stone-500">Updated by Admin</p>
            <div className="mt-4 divide-y">
              {versions.map((v) => (
                <div key={v.id} className="py-4">
                  <div className="flex justify-between">
                    <strong>Version {v.version}</strong>
                    {v.isActive ? (
                      <span className="text-xs font-semibold text-emerald-700">
                        Active
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {new Date(v.updatedAt).toLocaleString()}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => void view(v.version)}
                      className="text-sm font-semibold text-amber-800"
                    >
                      View
                    </button>
                    {!v.isActive ? (
                      <button
                        onClick={() => setRestore(v.version)}
                        className="text-sm font-semibold text-red-700"
                      >
                        Restore
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
      {preview ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6">
            <div className="flex justify-between">
              <h2 className="text-xl font-semibold">
                Version {preview.version}
              </h2>
              <button onClick={() => setPreview(undefined)}>Close</button>
            </div>
            <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-stone-50 p-5 text-sm">
              {preview.content}
            </pre>
          </div>
        </div>
      ) : null}
      {restore ? (
        <ConfirmModal
          title={`Restore version ${restore}?`}
          description="The selected content will be copied into a new active version. Current history will remain intact."
          confirmLabel="Restore"
          onConfirm={() => void doRestore()}
          onCancel={() => setRestore(undefined)}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </main>
  );
}
