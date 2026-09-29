'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Conversation = {
  id: string;
  status: string;
  channel: string;
  lastMessageAt: string;
  customer: { id: string; name: string | null; platform: string | null; platformUserId: string | null };
  _count: { messages: number };
};

export default function ConversationsPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<Conversation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true); setError('');
    try {
      const response = await adminRequest<{ success: true; data: { items: Conversation[] } }>('/admin/conversations?limit=100', password);
      setItems(response.data.items);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load conversations.'); }
    finally { setLoading(false); }
  }, [password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);

  return <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
    <h1 className="mb-2 text-4xl font-semibold tracking-tight">Conversations</h1>
    <p className="mb-8 text-stone-600">Review persistent channel-neutral customer conversations.</p>
    <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />
    {error ? <p className="mt-5 text-sm font-medium text-red-700">{error}</p> : null}
    <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="p-4">Customer</th><th className="p-4">Channel</th><th className="p-4">Status</th><th className="p-4">Messages</th><th className="p-4">Last activity</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id} className="border-t border-stone-100">
        <td className="p-4"><Link className="font-semibold text-amber-800 hover:underline" href={`/admin/conversations/${item.id}`}>{item.customer.name ?? item.customer.platformUserId ?? 'Anonymous'}</Link><p className="mt-1 text-xs text-stone-400">{item.id}</p></td>
        <td className="p-4 lowercase">{item.channel}</td><td className="p-4 lowercase">{item.status}</td><td className="p-4">{item._count.messages}</td><td className="p-4">{new Date(item.lastMessageAt).toLocaleString()}</td>
      </tr>)}</tbody></table>
      {!loading && items.length === 0 ? <p className="p-8 text-center text-stone-500">No conversations loaded.</p> : null}
    </div>
  </main>;
}
