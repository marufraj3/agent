'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Customer = { id: string; name: string | null; platform: string | null; platformUserId: string | null; language: string | null; updatedAt: string; _count: { conversations: number; messages: number } };

export default function CustomersPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<Customer[]>([]);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const attempted = useRef(false);
  const load = useCallback(async () => { if (!password) return; setLoading(true); setError(''); try { const response = await adminRequest<{ success: true; data: { items: Customer[] } }>('/admin/customers?limit=100', password); setItems(response.data.items); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load customers.'); } finally { setLoading(false); } }, [password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);
  return <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
    <h1 className="mb-2 text-4xl font-semibold tracking-tight">Customers</h1><p className="mb-8 text-stone-600">Platform identities map to one reusable customer record.</p>
    <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />
    {error ? <p className="mt-5 text-sm font-medium text-red-700">{error}</p> : null}
    <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="p-4">Customer</th><th className="p-4">Identity</th><th className="p-4">Language</th><th className="p-4">Conversations</th><th className="p-4">Messages</th></tr></thead><tbody>
      {items.map((item) => <tr key={item.id} className="border-t border-stone-100"><td className="p-4"><Link href={`/admin/customers/${item.id}`} className="font-semibold text-amber-800 hover:underline">{item.name ?? 'Unnamed customer'}</Link><p className="mt-1 text-xs text-stone-400">{item.id}</p></td><td className="p-4">{item.platform ?? '—'} / {item.platformUserId ?? '—'}</td><td className="p-4">{item.language ?? 'auto'}</td><td className="p-4">{item._count.conversations}</td><td className="p-4">{item._count.messages}</td></tr>)}
    </tbody></table>{!loading && items.length === 0 ? <p className="p-8 text-center text-stone-500">No customers loaded.</p> : null}</div>
  </main>;
}
