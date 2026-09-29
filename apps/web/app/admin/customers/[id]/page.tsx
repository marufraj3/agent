'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../../_components/admin-access';
import { adminRequest, useAdminPassword } from '../../_lib/admin-client';

type Detail = { id: string; name: string | null; platform: string | null; platformUserId: string | null; language: string | null; email: string | null; phone: string | null; conversations: { id: string; channel: string; status: string; lastMessageAt: string; _count: { messages: number } }[] };
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>(); const { password, setPassword, hydrated } = useAdminPassword(); const [data, setData] = useState<Detail>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const attempted = useRef(false);
  const load = useCallback(async () => { if (!password) return; setLoading(true); setError(''); try { const response = await adminRequest<{ success: true; data: Detail }>(`/admin/customers/${id}`, password); setData(response.data); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load customer.'); } finally { setLoading(false); } }, [id, password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);
  return <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14"><Link href="/admin/customers" className="text-sm font-semibold text-amber-800">← Customers</Link><h1 className="mt-4 text-3xl font-semibold">{data?.name ?? 'Customer detail'}</h1><p className="mb-8 mt-2 font-mono text-xs text-stone-500">{id}</p><AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />{error ? <p className="mt-5 text-red-700">{error}</p> : null}
  {data ? <><dl className="mt-6 grid gap-4 rounded-2xl border border-stone-200 bg-white p-6 text-sm sm:grid-cols-2"><div><dt className="text-stone-500">Platform identity</dt><dd className="mt-1 font-medium">{data.platform ?? '—'} / {data.platformUserId ?? '—'}</dd></div><div><dt className="text-stone-500">Language</dt><dd className="mt-1 font-medium">{data.language ?? 'auto'}</dd></div><div><dt className="text-stone-500">Email</dt><dd className="mt-1 font-medium">{data.email ?? '—'}</dd></div><div><dt className="text-stone-500">Phone</dt><dd className="mt-1 font-medium">{data.phone ?? '—'}</dd></div></dl><section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"><h2 className="text-xl font-semibold">Conversations</h2><div className="mt-4 divide-y divide-stone-100">{data.conversations.map((conversation) => <Link key={conversation.id} href={`/admin/conversations/${conversation.id}`} className="flex items-center justify-between gap-4 py-4 hover:text-amber-800"><span className="lowercase">{conversation.channel} · {conversation.status}</span><span className="text-sm text-stone-500">{conversation._count.messages} messages · {new Date(conversation.lastMessageAt).toLocaleString()}</span></Link>)}</div></section></> : null}</main>;
}
