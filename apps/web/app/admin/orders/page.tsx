'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Order = {
  id: string; status: string; submissionResult: string; totalQuantity: number;
  totalAmount: string; currency: string; externalOrderId: string | null; createdAt: string;
  customerSnapshot: { name?: string; phone?: string };
};

export default function OrdersPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [items, setItems] = useState<Order[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true); setError('');
    try {
      const response = await adminRequest<{ success: true; data: Order[] }>('/admin/orders?limit=100', password);
      setItems(response.data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load orders.'); }
    finally { setLoading(false); }
  }, [password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);

  return <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
    <h1 className="mb-2 text-4xl font-semibold tracking-tight">Orders</h1>
    <p className="mb-8 text-stone-600">Review AI-assisted drafts, confirmations, and website submission outcomes.</p>
    <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />
    {error ? <p className="mt-5 text-sm font-medium text-red-700">{error}</p> : null}
    <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="p-4">Customer</th><th className="p-4">Status</th><th className="p-4">Submission</th><th className="p-4">Items</th><th className="p-4">Total</th><th className="p-4">Created</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id} className="border-t border-stone-100">
        <td className="p-4"><Link className="font-semibold text-amber-800 hover:underline" href={`/admin/orders/${item.id}`}>{item.customerSnapshot?.name ?? item.customerSnapshot?.phone ?? 'Customer'}</Link><p className="mt-1 font-mono text-xs text-stone-400">{item.externalOrderId ?? item.id}</p></td>
        <td className="p-4 lowercase">{item.status.replaceAll('_', ' ')}</td><td className="p-4 lowercase">{item.submissionResult.replaceAll('_', ' ')}</td><td className="p-4">{item.totalQuantity}</td><td className="p-4">৳{Number(item.totalAmount).toFixed(2)}</td><td className="p-4">{new Date(item.createdAt).toLocaleString()}</td>
      </tr>)}</tbody></table>
      {!loading && items.length === 0 ? <p className="p-8 text-center text-stone-500">No orders loaded.</p> : null}
    </div>
  </main>;
}
