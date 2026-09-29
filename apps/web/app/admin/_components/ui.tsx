"use client";

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-3 p-5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-12 rounded-xl bg-stone-100" />
      ))}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
      <p className="font-medium text-red-800">{message}</p>
      <button
        onClick={retry}
        className="mt-3 rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white"
      >
        Try again
      </button>
    </div>
  );
}
export function EmptyState({ text }: { text: string }) {
  return <p className="p-10 text-center text-sm text-stone-500">{text}</p>;
}
export function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-stone-200 p-4 text-sm">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border px-3 py-1.5 disabled:opacity-30"
      >
        Previous
      </button>
      <span>
        {page} / {Math.max(1, pages)}
      </span>
      <button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border px-3 py-1.5 disabled:opacity-30"
      >
        Next
      </button>
    </div>
  );
}
export function Toast({
  message,
  type = "success",
  onClose,
}: {
  message: string;
  type?: "success" | "error";
  onClose: () => void;
}) {
  return (
    <div
      className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-xl px-5 py-3 text-sm font-medium text-white shadow-xl ${type === "success" ? "bg-emerald-700" : "bg-red-700"}`}
      role="status"
    >
      {message}
      <button className="ml-4 opacity-70" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
export function ConfirmModal({
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-stone-600">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-xl border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
export function Badge({
  children,
  tone = "stone",
}: {
  children: React.ReactNode;
  tone?: "stone" | "green" | "amber" | "red" | "blue";
}) {
  const colors = {
    stone: "bg-stone-100 text-stone-700",
    green: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    blue: "bg-blue-100 text-blue-800",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${colors[tone]}`}
    >
      {children}
    </span>
  );
}
