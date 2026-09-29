"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AdminAccess } from "../_components/admin-access";
import { adminRequest, useAdminPassword } from "../_lib/admin-client";

type Filter =
  | "all"
  | "unread"
  | "ai"
  | "human"
  | "closed"
  | "messenger"
  | "web";
type QuickReply = { id: string; title: string; message: string };
type Summary = {
  id: string;
  status: string;
  channel: string;
  assignedTo: string | null;
  unreadForAdmin: boolean;
  lastMessageAt: string;
  customer: {
    id: string;
    name: string | null;
    phone: string | null;
    platform: string | null;
    platformUserId: string | null;
  };
  messages: Array<{ content: string; role: string; createdAt: string }>;
  handovers: Array<{ reason: string; status: string }>;
};
type Metadata = {
  image?: { url?: string | null; mimeType?: string };
  audio?: { url?: string | null; mimeType?: string; duration?: number | null };
  transcription?: {
    text?: string;
    language?: string;
    confidence?: number;
    status?: string;
  };
  delivery?: { status?: string; provider?: string };
};
type Detail = Omit<Summary, "customer" | "messages" | "handovers"> & {
  customer: Summary["customer"] & {
    address: string | null;
    email: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
  messages: Array<{
    id: string;
    content: string;
    role: string;
    messageType: string;
    createdAt: string;
    metadata?: Metadata | null;
  }>;
  handovers: Array<{
    id: string;
    reason: string;
    note: string | null;
    status: string;
    assignedTo: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  orders: Array<{
    id: string;
    status: string;
    totalAmount: string;
    externalOrderId: string | null;
    items: Array<{
      id: string;
      productName: string;
      productCode: string;
      variationSize: string;
      quantity: number;
      unitPrice: string;
    }>;
  }>;
  discussedProducts: Array<{
    id: number;
    name: string;
    code: string;
    currentPrice: string;
    preOrder: boolean;
    active: boolean;
    sizes: Array<{ id: number; size: string; stock: number }>;
  }>;
};

const filters: Array<[Filter, string]> = [
  ["all", "All"],
  ["unread", "Unread"],
  ["ai", "AI"],
  ["human", "Human"],
  ["closed", "Closed"],
  ["messenger", "Messenger"],
  ["web", "Web"],
];

export default function InboxPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<Detail>();
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [unread, setUnread] = useState(0);
  const [reply, setReply] = useState("");
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);

  const loadList = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), filter });
      if (search) params.set("search", search);
      const response = await adminRequest<{
        success: true;
        data: { items: Summary[]; pages: number; unreadTotal: number };
      }>(`/admin/inbox?${params}`, password);
      setItems(response.data.items);
      setPages(Math.max(1, response.data.pages));
      setUnread(response.data.unreadTotal);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load inbox.",
      );
    } finally {
      setLoading(false);
    }
  }, [filter, page, password, search]);

  const openConversation = useCallback(
    async (id: string) => {
      if (!password) return;
      setSelectedId(id);
      setError("");
      try {
        const response = await adminRequest<{ success: true; data: Detail }>(
          `/admin/conversations/${id}`,
          password,
        );
        setSelected(response.data);
        setItems((current) =>
          current.map((item) =>
            item.id === id ? { ...item, unreadForAdmin: false } : item,
          ),
        );
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not open conversation.",
        );
      }
    },
    [password],
  );

  useEffect(() => {
    if (hydrated && !attempted.current) {
      attempted.current = true;
      if (password) {
        void loadList();
        void adminRequest<{ data: QuickReply[] }>(
          "/admin/quick-replies",
          password,
        )
          .then((response) => setQuickReplies(response.data))
          .catch(() => undefined);
      }
    }
  }, [hydrated, password, loadList]);
  useEffect(() => {
    if (attempted.current && password) void loadList();
  }, [filter, page, search, password, loadList]);
  useEffect(() => {
    if (!password) return;
    const timer = window.setInterval(() => void loadList(), 15_000);
    return () => window.clearInterval(timer);
  }, [password, loadList]);

  async function action(path: string, body: object = {}) {
    if (!password || !selectedId) return;
    setLoading(true);
    setError("");
    try {
      await adminRequest(
        `/admin/conversations/${selectedId}/${path}`,
        password,
        { method: "POST", body: JSON.stringify(body) },
      );
      await Promise.all([loadList(), openConversation(selectedId)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setLoading(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!reply.trim() || !password || !selectedId) return;
    setLoading(true);
    setError("");
    try {
      await adminRequest(
        `/admin/conversations/${selectedId}/messages`,
        password,
        { method: "POST", body: JSON.stringify({ content: reply }) },
      );
      setReply("");
      await Promise.all([loadList(), openConversation(selectedId)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reply failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-7 sm:px-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Conversation Inbox
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            Human handovers and channel-ready replies · {unread} unread
          </p>
        </div>
        <button
          onClick={() => void loadList()}
          disabled={loading}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      <AdminAccess
        password={password}
        onPasswordChange={setPassword}
        onLoad={() => void loadList()}
        loading={loading}
      />
      {error ? (
        <p className="my-4 rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm lg:grid lg:h-[calc(100vh-230px)] lg:min-h-[650px] lg:grid-cols-[380px_1fr]">
        <aside className="flex max-h-[680px] flex-col border-b border-stone-200 lg:max-h-none lg:border-b-0 lg:border-r">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
            className="border-b border-stone-200 p-3"
          >
            <div className="flex gap-2">
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Name, phone, order, product…"
                className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-600"
              />
              <button className="rounded-xl bg-stone-900 px-3 text-sm font-semibold text-white">
                Search
              </button>
            </div>
            <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
              {filters.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </form>
          <div className="flex-1 overflow-y-auto">
            {items.map((item) => {
              const latest = item.messages[0];
              const handover = item.handovers[0];
              return (
                <button
                  key={item.id}
                  onClick={() => void openConversation(item.id)}
                  className={`block w-full border-b border-stone-100 p-4 text-left transition hover:bg-stone-50 ${selectedId === item.id ? "bg-amber-50" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-stone-900 text-xs font-bold text-white">
                        {(item.customer.name ?? "C").slice(0, 1).toUpperCase()}
                      </span>
                      <p className="truncate font-semibold text-stone-900">
                        {item.customer.name ??
                          item.customer.phone ??
                          item.customer.platformUserId ??
                          "Customer"}
                      </p>
                    </div>
                    <time className="whitespace-nowrap text-[11px] text-stone-400">
                      {new Date(item.lastMessageAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p className="mt-1 truncate text-sm text-stone-500">
                    {latest
                      ? `${latest.role.toLowerCase()}: ${latest.content}`
                      : "No messages"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
                    <span className="rounded bg-stone-100 px-1.5 py-1">
                      {item.channel}
                    </span>
                    <span className="rounded bg-stone-100 px-1.5 py-1">
                      {item.status}
                    </span>
                    {handover ? (
                      <span className="rounded bg-red-50 px-1.5 py-1 text-red-700">
                        {handover.reason.replaceAll("_", " ")}
                      </span>
                    ) : null}
                    {item.assignedTo ? (
                      <span className="rounded bg-blue-50 px-1.5 py-1 text-blue-700">
                        {item.assignedTo}
                      </span>
                    ) : null}
                    {item.unreadForAdmin ? (
                      <span
                        className="ml-auto rounded-full bg-amber-500 px-2 py-0.5 text-white"
                        title="Unread"
                      >
                        1
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
            {!loading && items.length === 0 ? (
              <p className="p-8 text-center text-sm text-stone-500">
                No conversations found.
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t border-stone-200 p-3 text-xs">
            <button
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
              className="rounded-lg border px-3 py-1.5 disabled:opacity-30"
            >
              Previous
            </button>
            <span>
              {page} / {pages}
            </span>
            <button
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
              className="rounded-lg border px-3 py-1.5 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </aside>
        <section className="min-h-[600px] overflow-y-auto bg-stone-50/50">
          {selected ? (
            <div className="flex min-h-full flex-col">
              <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/95 p-4 backdrop-blur sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">
                      {selected.customer.name ?? "Customer"}
                    </h2>
                    <p className="mt-1 text-xs text-stone-500">
                      {selected.customer.phone ?? "No phone"} ·{" "}
                      {selected.channel.toLowerCase()} ·{" "}
                      {selected.status.toLowerCase()} · assigned:{" "}
                      {selected.assignedTo ?? "none"}
                      {selected.handovers[0]
                        ? ` · ${selected.handovers[0].reason.replaceAll("_", " ").toLowerCase()}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.status === "HUMAN" && !selected.assignedTo ? (
                      <button
                        onClick={() => void action("take")}
                        className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Take Conversation
                      </button>
                    ) : null}
                    {selected.status === "HUMAN" && selected.assignedTo ? (
                      <button
                        onClick={() => void action("release")}
                        className="rounded-lg border px-3 py-2 text-xs font-semibold"
                      >
                        Release
                      </button>
                    ) : null}
                    {selected.status === "HUMAN" ? (
                      <button
                        onClick={() => {
                          const note = window.prompt(
                            "Optional resolution note:",
                          );
                          if (note !== null)
                            void action("return-to-ai", { note: note || null });
                        }}
                        className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Return to AI
                      </button>
                    ) : null}
                    {selected.status === "ACTIVE" ? (
                      <button
                        onClick={() =>
                          window.confirm(
                            "Move this conversation to the human inbox?",
                          ) && void action("handover", { reason: "other" })
                        }
                        className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Handover
                      </button>
                    ) : null}
                    {selected.status !== "CLOSED" ? (
                      <button
                        onClick={() =>
                          window.confirm("Close this conversation?") &&
                          void action("close")
                        }
                        className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Close
                      </button>
                    ) : (
                      <button
                        onClick={() => void action("reopen")}
                        className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Reopen
                      </button>
                    )}
                  </div>
                </div>
              </header>
              {selected.status === "HUMAN" ? (
                <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
                  <strong>Human Support Active</strong> — AI replies are paused.
                  {selected.handovers[0]
                    ? ` Reason: ${selected.handovers[0].reason.replaceAll("_", " ").toLowerCase()}.`
                    : ""}
                </div>
              ) : null}
              <div className="grid gap-4 p-4 xl:grid-cols-[1fr_290px] xl:p-5">
                <div className="space-y-3">
                  {selected.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm shadow-sm ${message.role === "USER" ? "ml-auto bg-stone-900 text-white" : message.role === "HUMAN" ? "bg-blue-700 text-white" : "border border-stone-200 bg-white"}`}
                    >
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-wider opacity-60">
                        {message.role}
                      </p>
                      {message.messageType === "IMAGE" &&
                      message.metadata?.image?.url ? (
                        <img
                          src={message.metadata.image.url}
                          alt="Customer attachment"
                          className="mb-2 max-h-64 rounded-lg object-contain"
                        />
                      ) : null}
                      {message.messageType === "AUDIO" &&
                      message.metadata?.audio?.url ? (
                        <audio
                          controls
                          src={message.metadata.audio.url}
                          className="mb-2 max-w-full"
                        />
                      ) : null}
                      <p className="whitespace-pre-wrap leading-6">
                        {message.content}
                      </p>
                      {message.metadata?.transcription?.text ? (
                        <div className="mt-2 rounded-lg bg-white/10 p-2">
                          <p className="text-[10px] opacity-60">
                            TRANSCRIPTION
                          </p>
                          <p>{message.metadata.transcription.text}</p>
                        </div>
                      ) : null}
                      <p className="mt-2 text-[10px] opacity-50">
                        {new Date(message.createdAt).toLocaleString()}
                        {message.metadata?.delivery?.status
                          ? ` · ${message.metadata.delivery.status}`
                          : ""}
                      </p>
                    </article>
                  ))}
                </div>
                <aside className="space-y-3">
                  <Panel title="Customer">
                    <p>{selected.customer.name ?? "No name"}</p>
                    <p>{selected.customer.phone ?? "No phone"}</p>
                    <p>{selected.customer.email ?? "No email"}</p>
                    <p>{selected.customer.address ?? "No address"}</p>
                    <p className="text-xs text-stone-500">
                      {selected.customer.platform ?? "platform unknown"} ·{" "}
                      {selected.customer.platformUserId ?? "no platform ID"}
                    </p>
                    <p className="break-all text-xs text-stone-400">
                      ID: {selected.customer.id}
                    </p>
                    {selected.customer.createdAt ? (
                      <p className="text-xs text-stone-400">
                        First seen:{" "}
                        {new Date(selected.customer.createdAt).toLocaleString()}
                      </p>
                    ) : null}
                    {selected.customer.updatedAt ? (
                      <p className="text-xs text-stone-400">
                        Last seen:{" "}
                        {new Date(selected.customer.updatedAt).toLocaleString()}
                      </p>
                    ) : null}
                    <div className="mt-2">
                      <Link
                        href={`/admin/customers/${selected.customer.id}`}
                        className="font-semibold text-amber-800"
                      >
                        View Customer →
                      </Link>
                    </div>
                  </Panel>
                  {selected.handovers[0] ? (
                    <Panel title="Handover">
                      <p className="font-medium">
                        {selected.handovers[0].reason.replaceAll("_", " ")}
                      </p>
                      <p>{selected.handovers[0].note ?? "No note"}</p>
                      <p className="text-xs text-stone-500">
                        {selected.handovers[0].status.toLowerCase()} ·{" "}
                        {new Date(
                          selected.handovers[0].createdAt,
                        ).toLocaleString()}
                      </p>
                    </Panel>
                  ) : null}
                  <Panel title="Orders">
                    {selected.orders.length ? (
                      selected.orders.map((order) => (
                        <Link
                          key={order.id}
                          href={`/admin/orders/${order.id}`}
                          className="mb-2 block rounded-lg bg-stone-50 p-2"
                        >
                          <span className="font-semibold">
                            ৳{Number(order.totalAmount).toFixed(2)}
                          </span>{" "}
                          · {order.status.toLowerCase()}
                          <p className="text-xs text-stone-500">
                            {order.externalOrderId
                              ? `External: ${order.externalOrderId} · `
                              : ""}
                            {order.items
                              .map(
                                (item) =>
                                  `${item.productCode} ${item.variationSize} ×${item.quantity} @ ৳${Number(item.unitPrice).toFixed(2)}`,
                              )
                              .join(", ") || "No items"}
                          </p>
                        </Link>
                      ))
                    ) : (
                      <p className="text-stone-500">No orders</p>
                    )}
                  </Panel>
                  <Panel title="Recent products">
                    {selected.discussedProducts.length ? (
                      selected.discussedProducts.map((product) => (
                        <div key={product.id} className="mb-2">
                          <p className="font-medium">{product.name}</p>
                          <p className="text-xs text-stone-500">
                            {product.code} · ৳{product.currentPrice} ·{" "}
                            {product.sizes
                              .map((size) => `${size.size}:${size.stock}`)
                              .join(" ")}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="text-stone-500">No product context</p>
                    )}
                  </Panel>
                </aside>
              </div>
              {selected.status === "HUMAN" ? (
                <form
                  onSubmit={(event) => void send(event)}
                  className="sticky bottom-0 mt-auto border-t border-stone-200 bg-white p-4"
                >
                  <div className="mb-2 flex gap-2 overflow-x-auto">
                    {quickReplies.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => setReply(item.message)}
                        className="whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-stone-50"
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      rows={2}
                      maxLength={4000}
                      placeholder="Reply as a human agent… Enter to send, Shift+Enter for a new line"
                      className="min-w-0 flex-1 resize-none rounded-xl border border-stone-300 p-3 text-sm outline-none focus:border-blue-600"
                    />
                    <button
                      disabled={loading || !reply.trim()}
                      className="rounded-xl bg-blue-700 px-5 font-semibold text-white disabled:opacity-40"
                    >
                      Send
                    </button>
                  </div>
                </form>
              ) : (
                <p className="sticky bottom-0 mt-auto border-t bg-white p-4 text-center text-sm text-stone-500">
                  Human reply is locked while this conversation is{" "}
                  {selected.status.toLowerCase()}.
                </p>
              )}
            </div>
          ) : (
            <div className="grid h-full place-items-center p-12 text-center text-stone-500">
              <div>
                <p className="text-4xl">💬</p>
                <p className="mt-3 font-medium">
                  Select a conversation to view its complete context.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
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
    <section className="rounded-xl border border-stone-200 bg-white p-4 text-sm">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-stone-400">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}
