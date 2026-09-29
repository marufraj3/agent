'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../../_components/admin-access';
import { adminRequest, useAdminPassword } from '../../_lib/admin-client';

type Order = {
  id: string; status: string; confirmationStatus: string; submissionResult: string;
  submissionReference: string; externalOrderId: string | null; externalResponse: unknown;
  failureCode: string | null; failureMessage: string | null; deliveryLocation: string | null;
  subtotal: string; deliveryCharge: string; totalAmount: string; totalQuantity: number;
  createdAt: string; updatedAt: string;
  customerSnapshot: { name?: string; phone?: string; address?: string };
  customer: { id: string };
  conversation: { id: string };
  items: Array<{ id: string; productName: string; productCode: string; variationSize: string; quantity: number; unitPrice: string; lineTotal: string; websiteProductId: number; websiteVariationId: number }>;
};

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { password, setPassword, hydrated } = useAdminPassword();
  const [data, setData] = useState<Order>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true); setError('');
    try { const response = await adminRequest<{ success: true; data: Order }>(`/admin/orders/${id}`, password); setData(response.data); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load order.'); }
    finally { setLoading(false); }
  }, [id, password]);
  const retry = useCallback(async () => {
    if (!password || !window.confirm('Retry this known-failed submission after revalidation?')) return;
    setLoading(true); setError('');
    try { const response = await adminRequest<{ success: true; data: Order }>(`/admin/orders/${id}/retry`, password, { method: 'POST' }); setData(response.data); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Retry failed.'); }
    finally { setLoading(false); }
  }, [id, password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);

  return <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
    <Link href="/admin/orders" className="text-sm font-semibold text-amber-800">← Orders</Link>
    <h1 className="mt-4 text-3xl font-semibold">Order detail</h1><p className="mb-8 mt-2 font-mono text-xs text-stone-500">{id}</p>
    <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-700">{error}</p> : null}
    {data ? <div className="mt-6 space-y-5">
      <section className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-6 text-sm sm:grid-cols-3">
        <div><p className="text-stone-500">Status</p><p className="mt-1 font-semibold lowercase">{data.status.replaceAll('_', ' ')}</p></div>
        <div><p className="text-stone-500">Confirmation</p><p className="mt-1 font-semibold lowercase">{data.confirmationStatus}</p></div>
        <div><p className="text-stone-500">Submission</p><p className="mt-1 font-semibold lowercase">{data.submissionResult.replaceAll('_', ' ')}</p></div>
        <div><p className="text-stone-500">External ID</p><p className="mt-1 font-mono">{data.externalOrderId ?? '—'}</p></div>
        <div><p className="text-stone-500">Conversation</p><Link href={`/admin/conversations/${data.conversation.id}`} className="mt-1 block font-semibold text-amber-800">Open conversation</Link></div>
        <div><p className="text-stone-500">Updated</p><p className="mt-1">{new Date(data.updatedAt).toLocaleString()}</p></div>
      </section>
      <section className="rounded-2xl border border-stone-200 bg-white p-6"><h2 className="text-lg font-semibold">Customer & delivery</h2><div className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><p><span className="text-stone-500">Name:</span> {data.customerSnapshot.name ?? '—'}</p><p><span className="text-stone-500">Phone:</span> {data.customerSnapshot.phone ?? '—'}</p><p className="sm:col-span-2"><span className="text-stone-500">Address:</span> {data.customerSnapshot.address ?? '—'}</p><p><span className="text-stone-500">Area:</span> {data.deliveryLocation?.replaceAll('_', ' ').toLowerCase() ?? '—'}</p></div></section>
      <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="p-4">Product</th><th className="p-4">Variation</th><th className="p-4">Qty</th><th className="p-4">Unit</th><th className="p-4">Line total</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id} className="border-t border-stone-100"><td className="p-4 font-medium">{item.productName}<p className="text-xs text-stone-400">{item.productCode} · #{item.websiteProductId}</p></td><td className="p-4">{item.variationSize}<p className="text-xs text-stone-400">#{item.websiteVariationId}</p></td><td className="p-4">{item.quantity}</td><td className="p-4">৳{Number(item.unitPrice).toFixed(2)}</td><td className="p-4">৳{Number(item.lineTotal).toFixed(2)}</td></tr>)}</tbody></table><div className="border-t border-stone-200 p-5 text-right text-sm"><p>Subtotal: ৳{Number(data.subtotal).toFixed(2)}</p><p>Delivery: ৳{Number(data.deliveryCharge).toFixed(2)}</p><p className="mt-2 text-lg font-semibold">Total: ৳{Number(data.totalAmount).toFixed(2)}</p></div></section>
      {data.failureCode || data.externalResponse ? <section className="rounded-2xl border border-stone-200 bg-white p-6"><h2 className="text-lg font-semibold">Submission details</h2>{data.failureCode ? <p className="mt-3 text-red-700"><strong>{data.failureCode}:</strong> {data.failureMessage}</p> : null}{data.externalResponse ? <pre className="mt-4 overflow-auto rounded-xl bg-stone-950 p-4 text-xs text-stone-100">{JSON.stringify(data.externalResponse, null, 2)}</pre> : null}</section> : null}
      {data.status === 'FAILED' && data.submissionResult === 'KNOWN_FAILURE' ? <button onClick={() => void retry()} disabled={loading} className="rounded-xl bg-red-700 px-5 py-3 font-semibold text-white disabled:opacity-50">Explicitly retry safe failure</button> : null}
      {data.submissionResult === 'UNKNOWN' ? <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">The external outcome is unknown. Retry is blocked to prevent a duplicate customer order.</p> : null}
    </div> : null}
  </main>;
}
