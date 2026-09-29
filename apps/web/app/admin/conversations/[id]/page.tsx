'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../../_components/admin-access';
import { adminRequest, useAdminPassword } from '../../_lib/admin-client';

type Detail = { id: string; status: string; channel: string; customer: { id: string; name: string | null; platformUserId: string | null }; messages: { id: string; role: string; content: string; createdAt: string }[] };
export default function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>(); const { password, setPassword, hydrated } = useAdminPassword(); const [data, setData] = useState<Detail>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const attempted = useRef(false);
  const load = useCallback(async () => { if (!password) return; setLoading(true); setError(''); try { const response = await adminRequest<{ success: true; data: Detail }>(`/admin/conversations/${id}`, password); setData(response.data); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load conversation.'); } finally { setLoading(false); } }, [id, password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);
  return <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14"><Link href="/admin/conversations" className="text-sm font-semibold text-amber-800">← Conversations</Link><h1 className="mt-4 text-3xl font-semibold">Conversation detail</h1><p className="mb-8 mt-2 font-mono text-xs text-stone-500">{id}</p><AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading} />{error ? <p className="mt-5 text-red-700">{error}</p> : null}
  {data ? <><div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 text-sm"><Link href={`/admin/customers/${data.customer.id}`} className="font-semibold text-amber-800">{data.customer.name ?? data.customer.platformUserId ?? 'Customer'}</Link><span className="ml-4 lowercase text-stone-500">{data.channel} · {data.status}</span></div><div className="mt-5 space-y-3 rounded-3xl border border-stone-200 bg-white p-5 sm:p-8">{data.messages.map((message) => <div key={message.id} className={`max-w-[85%] rounded-2xl px-4 py-3 ${message.role === 'USER' ? 'ml-auto bg-stone-900 text-white' : 'bg-amber-50'}`}><p className="whitespace-pre-wrap leading-6">{message.content}</p><p className="mt-2 text-xs opacity-60">{message.role.toLowerCase()} · {new Date(message.createdAt).toLocaleString()}</p></div>)}</div></> : null}</main>;
}
