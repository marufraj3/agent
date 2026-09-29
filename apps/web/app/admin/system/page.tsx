'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Queue = { name: string; counts: Record<string, number> };
type Health = { status: string; database: string; redis: string; queues: Queue[]; workers: {name:string; heartbeat:string|null}[]; uptimeSeconds:number; latestProductSync:{createdAt:string}|null; productMetrics:{available:number;stale:number;staleAfterHours:number}|null; circuits:{service:string;state:string;failures:number}[] };
type Window = { days:number; customers:number; conversations:number; orders:number; failedEvents:number };
export default function SystemPage() {
  const { password, setPassword, hydrated } = useAdminPassword(); const [health,setHealth]=useState<Health>(); const [analytics,setAnalytics]=useState<Window[]>([]); const [error,setError]=useState(''); const [loading,setLoading]=useState(false);
  const load=useCallback(async()=>{if(!password)return;setLoading(true);setError('');try{const [h,a]=await Promise.all([adminRequest<{data:Health}>('/admin/system/health',password),adminRequest<{data:Window[]}>('/admin/system/analytics',password)]);setHealth(h.data);setAnalytics(a.data)}catch(e){setError(e instanceof Error?e.message:'Could not load system health')}finally{setLoading(false)}},[password]);
  useEffect(()=>{if(hydrated&&password)void load()},[hydrated,password,load]);
  return <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8"><div className="flex items-end justify-between"><div><h1 className="text-4xl font-semibold">System health</h1><p className="mt-2 text-stone-600">Dependencies, workers, queues and recent activity.</p></div><Link className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white" href="/admin/system/jobs">Manage jobs</Link></div>
  <AdminAccess password={password} onPasswordChange={setPassword} onLoad={()=>void load()} loading={loading}/>{error?<p className="mt-4 rounded-xl bg-red-50 p-4 text-red-700">{error}</p>:null}
  {health?<><div className="mt-6 grid gap-3 sm:grid-cols-3">{([['Overall',health.status],['Database',health.database],['Redis',health.redis]] as [string,string][]).map(([a,b])=><Card key={a} label={a} value={b}/>)}</div>
  <div className="mt-3 grid gap-3 sm:grid-cols-2"><Card label="Latest product sync" value={health.latestProductSync?new Date(health.latestProductSync.createdAt).toLocaleString():'No completed sync'}/><Card label="Product freshness" value={health.productMetrics?`${health.productMetrics.available} available · ${health.productMetrics.stale} stale over ${health.productMetrics.staleAfterHours}h`:'Unavailable'}/></div>
  <h2 className="mt-8 text-xl font-semibold">Queues</h2><div className="mt-3 grid gap-3 lg:grid-cols-2">{health.queues.map(q=><Card key={q.name} label={q.name} value={Object.entries(q.counts).map(([k,v])=>`${k}: ${v}`).join(' · ')}/>)}</div>
  <h2 className="mt-8 text-xl font-semibold">Workers & services</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{health.workers.map(w=><Card key={w.name} label={w.name} value={w.heartbeat?`Heartbeat ${new Date(w.heartbeat).toLocaleString()}`:'No active heartbeat'}/>)}{health.circuits.map(c=><Card key={c.service} label={`${c.service} circuit`} value={`${c.state} · ${c.failures} failures`}/>)}</div>
  <h2 className="mt-8 text-xl font-semibold">Today / 7 / 30 days</h2><div className="mt-3 grid gap-3 sm:grid-cols-3">{analytics.map(a=><Card key={a.days} label={a.days===1?'Today':`${a.days} days`} value={`${a.customers} customers · ${a.conversations} conversations · ${a.orders} orders · ${a.failedEvents} errors`}/>)}</div></>:null}</main>;
}
function Card({label,value}:{label:string;value:string}){return <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-stone-400">{label}</p><p className="mt-2 font-medium text-stone-900">{value}</p></section>}
