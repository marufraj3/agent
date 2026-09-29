"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminAccess } from "../../_components/admin-access";
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingRows,
  Pagination,
  Toast,
} from "../../_components/ui";
import { adminRequest, useAdminPassword } from "../../_lib/admin-client";
type J = {
  queue: string;
  id: string;
  name: string;
  attemptsMade: number;
  createdAt: string;
  failedAt: string | null;
  error: string | null;
  stack: string | null;
};
type R = { items: J[]; page: number; pages: number; total: number };
export default function Jobs() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<R>({
    items: [],
    page: 1,
    pages: 1,
    total: 0,
  });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<J>();
  const [remove, setRemove] = useState<J>();
  const [toast, setToast] = useState("");
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        (
          await adminRequest<{ data: R }>(
            `/admin/system/jobs?page=${page}&limit=25`,
            password,
          )
        ).data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load failed jobs.");
    } finally {
      setLoading(false);
    }
  }, [password, page]);
  useEffect(() => {
    if (hydrated && password) void load();
  }, [hydrated, password, load]);
  async function action(j: J, method: "POST" | "DELETE") {
    try {
      await adminRequest(
        `/admin/system/jobs/${encodeURIComponent(j.queue)}/${encodeURIComponent(j.id)}${method === "POST" ? "/retry" : ""}`,
        password,
        { method },
      );
      setToast(method === "POST" ? "Job queued for retry" : "Job removed");
      setRemove(undefined);
      setSelected(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Job action failed.");
    }
  }
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <h1 className="text-3xl font-semibold">Failed Jobs</h1>
      <div className="mt-4 flex gap-2">
        <Link
          href="/admin/system"
          className="rounded-full border bg-white px-4 py-2 text-sm"
        >
          Health
        </Link>
        <span className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white">
          Jobs
        </span>
        <Link
          href="/admin/system/logs"
          className="rounded-full border bg-white px-4 py-2 text-sm"
        >
          Logs
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
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full min-w-[850px] text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              <th className="p-4">Queue / Job</th>
              <th className="p-4">Attempts</th>
              <th className="p-4">Created</th>
              <th className="p-4">Failed</th>
              <th className="p-4">Error</th>
              <th className="p-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((j) => (
              <tr key={`${j.queue}:${j.id}`} className="border-t">
                <td className="p-4">
                  <strong>{j.queue}</strong>
                  <p className="font-mono text-xs text-stone-500">
                    {j.name} · {j.id}
                  </p>
                </td>
                <td className="p-4">{j.attemptsMade}</td>
                <td className="p-4">
                  {new Date(j.createdAt).toLocaleString()}
                </td>
                <td className="p-4">
                  {j.failedAt ? new Date(j.failedAt).toLocaleString() : "—"}
                </td>
                <td className="max-w-72 truncate p-4 text-red-700">
                  {j.error ?? "Unknown"}
                </td>
                <td className="p-4">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelected(j)}
                      className="font-semibold text-blue-700"
                    >
                      View Error
                    </button>
                    <button
                      onClick={() => void action(j, "POST")}
                      className="font-semibold text-emerald-700"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => setRemove(j)}
                      className="font-semibold text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingRows />
        ) : !data.items.length ? (
          <EmptyState text="No failed jobs." />
        ) : null}
        <Pagination page={page} pages={data.pages} onPage={setPage} />
      </div>
      {selected ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6">
            <div className="flex justify-between">
              <h2 className="text-xl font-semibold">Failed job detail</h2>
              <button onClick={() => setSelected(undefined)}>Close</button>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2">
              <Info k="Queue" v={selected.queue} />
              <Info k="Job ID" v={selected.id} />
              <Info k="Attempts" v={String(selected.attemptsMade)} />
              <Info
                k="Created"
                v={new Date(selected.createdAt).toLocaleString()}
              />
              <Info
                k="Failed"
                v={
                  selected.failedAt
                    ? new Date(selected.failedAt).toLocaleString()
                    : "—"
                }
              />
            </dl>
            <h3 className="mt-5 font-semibold">Error</h3>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-red-50 p-4 text-sm text-red-800">
              {selected.error}
            </pre>
            <h3 className="mt-5 font-semibold">Authorized stack trace</h3>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-xl bg-stone-950 p-4 text-xs text-stone-100">
              {selected.stack ?? "No retained stack trace."}
            </pre>
          </div>
        </div>
      ) : null}
      {remove ? (
        <ConfirmModal
          title="Remove failed job?"
          description="The retained failure will be permanently removed from Redis."
          confirmLabel="Remove"
          onConfirm={() => void action(remove, "DELETE")}
          onCancel={() => setRemove(undefined)}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </main>
  );
}
function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-stone-400">{k}</dt>
      <dd className="mt-1 break-all font-medium">{v}</dd>
    </div>
  );
}
