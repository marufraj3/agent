'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { Badge, ErrorState, LoadingRows } from '../_components/ui';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Overview = {
  overview: Record<string, number>;
  trends: {
    topSearchedProducts: ProductTrend[];
    mostDiscussedProducts: ProductTrend[];
    popularCategories: Array<{ category: string; count: number }>;
    commonRequestedSizes: Array<{ size: string; count: number }>;
    commonPriceRanges: Array<{ range: string; count: number }>;
  };
  insights: string[];
};
type ProductTrend = { productCode: string; productName: string; searched: number; discussed: number; recommended: number };
type Funnel = Record<string, number>;
type ProductMetric = { productId: number; productCode: string; productName: string; searched: number; recommended: number; selected: number; discussed: number; orderQuantity: number; orders: number; currentStock: number; currentPrice: string; isPreOrder: boolean };
type Controls = { enabled: boolean; maxRecommendations: number; crossSellEnabled: boolean; upsellEnabled: boolean; cacheTtlSeconds: number };

const ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['custom', 'Custom']] as const;
const labels: Record<string, string> = {
  conversations: 'Conversations', productInquiries: 'Product inquiries', productSearches: 'Product searches',
  productSelections: 'Selections', orders: 'Orders', abandonedOrders: 'Abandoned', humanHandovers: 'Handovers',
  recommendationUsage: 'Recommendation use', recommendationToOrder: 'Recommendation → order', recommendationToOrderRate: 'Recommendation conversion %',
};

export default function SalesIntelligencePage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [range, setRange] = useState('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overview, setOverview] = useState<Overview>();
  const [funnel, setFunnel] = useState<Funnel>();
  const [products, setProducts] = useState<ProductMetric[]>([]);
  const [controls, setControls] = useState<Controls>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true); setError('');
    try {
      const queryParams = new URLSearchParams({ range });
      if (range === 'custom') {
        if (!from || !to) { setLoading(false); return; }
        queryParams.set('from', new Date(`${from}T00:00:00+06:00`).toISOString());
        queryParams.set('to', new Date(`${to}T23:59:59+06:00`).toISOString());
      }
      const query = queryParams.toString();
      const [overviewResult, funnelResult, productResult, controlResult] = await Promise.all([
        adminRequest<{ data: Overview }>(`/admin/sales-intelligence/overview?${query}`, password),
        adminRequest<{ data: Funnel }>(`/admin/sales-intelligence/funnel?${query}`, password),
        adminRequest<{ data: { items: ProductMetric[] } }>(`/admin/sales-intelligence/products?${query}&limit=20`, password),
        adminRequest<{ data: Controls }>('/admin/recommendations/settings', password),
      ]);
      setOverview(overviewResult.data); setFunnel(funnelResult.data); setProducts(productResult.data.items); setControls(controlResult.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load sales intelligence.'); }
    finally { setLoading(false); }
  }, [password, range, from, to]);
  useEffect(() => { if (hydrated && password) void load(); }, [hydrated, password, load]);
  async function saveControls() {
    if (!controls || !password) return;
    setLoading(true); setError('');
    try {
      const result = await adminRequest<{ data: Controls }>('/admin/recommendations/settings', password, { method: 'PUT', body: JSON.stringify(controls) });
      setControls(result.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save recommendation controls.'); }
    finally { setLoading(false); }
  }

  return <main className="mx-auto max-w-7xl px-4 py-7 sm:px-8">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-widest text-amber-700">Factual conversion analytics</p><h1 className="mt-1 text-3xl font-semibold">Sales Intelligence</h1><p className="mt-2 text-sm text-stone-500">Calculated from conversations, sales events, products, and orders.</p></div>
      <div className="flex gap-2">{ranges.map(([key, title]) => <button key={key} onClick={() => setRange(key)} className={`rounded-full px-3 py-2 text-xs font-semibold ${range === key ? 'bg-stone-900 text-white' : 'border bg-white'}`}>{title}</button>)}</div>
    </div>
    {range === 'custom' ? <div className="mt-4 flex flex-wrap gap-2"><input aria-label="From date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="rounded-xl border bg-white px-3 py-2"/><input aria-label="To date" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="rounded-xl border bg-white px-3 py-2"/><button onClick={() => void load()} className="rounded-xl bg-stone-900 px-4 py-2 text-sm text-white">Apply</button></div> : null}
    <div className="mt-5"><AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading}/></div>
    {error ? <div className="mt-5"><ErrorState message={error} retry={() => void load()}/></div> : null}
    {loading && !overview ? <LoadingRows/> : null}
    {overview && funnel ? <div className="mt-6 space-y-7">
      {controls ? <section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Recommendation controls</h2><p className="mt-1 text-sm text-stone-500">Applied server-side to local Product DB recommendations.</p></div><button onClick={() => void saveControls()} disabled={loading} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save controls</button></div><div className="mt-4 flex flex-wrap gap-5 text-sm"><Toggle label="Recommendations" checked={controls.enabled} onChange={(value) => setControls({ ...controls, enabled: value })}/><Toggle label="Cross-sell" checked={controls.crossSellEnabled} onChange={(value) => setControls({ ...controls, crossSellEnabled: value })}/><Toggle label="Controlled upsell" checked={controls.upsellEnabled} onChange={(value) => setControls({ ...controls, upsellEnabled: value })}/><label className="flex items-center gap-2">Maximum<select value={controls.maxRecommendations} onChange={(event) => setControls({ ...controls, maxRecommendations: Number(event.target.value) })} className="rounded-lg border px-2 py-1">{[1,2,3].map((value) => <option key={value}>{value}</option>)}</select></label><label className="flex items-center gap-2">Cache TTL<input type="number" min={5} max={900} value={controls.cacheTtlSeconds} onChange={(event) => setControls({ ...controls, cacheTtlSeconds: Number(event.target.value) })} className="w-24 rounded-lg border px-2 py-1"/>sec</label></div></section> : null}
      <section><h2 className="mb-3 text-lg font-semibold">Overview</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(overview.overview).filter(([key]) => key !== 'conversionEvents').map(([key, value]) => <Metric key={key} label={labels[key] ?? humanize(key)} value={value}/>)}</div></section>
      <section className="grid gap-6 lg:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h2 className="font-semibold">Funnel</h2><div className="mt-4 space-y-2">{Object.entries(funnel).map(([key, value]) => <div key={key} className="flex justify-between border-b py-2 text-sm"><span>{humanize(key)}</span><strong>{value}</strong></div>)}</div></div><div className="rounded-2xl border bg-white p-5"><h2 className="font-semibold">Calculated insights</h2>{overview.insights.length ? <ul className="mt-4 space-y-3 text-sm text-stone-700">{overview.insights.map((item) => <li key={item} className="rounded-xl bg-stone-50 p-3">{item}</li>)}</ul> : <p className="mt-4 text-sm text-stone-500">No sufficient event data for this period.</p>}</div></section>
      <section><h2 className="mb-3 text-lg font-semibold">Product performance</h2><div className="overflow-x-auto rounded-2xl border bg-white"><table className="min-w-full text-left text-sm"><thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Product','Searches','Recommended','Selected','Orders','Qty','Stock','Price'].map((item) => <th key={item} className="px-4 py-3">{item}</th>)}</tr></thead><tbody>{products.map((product) => <tr key={product.productId} className="border-t"><td className="px-4 py-3"><strong>{product.productCode}</strong><span className="block text-xs text-stone-500">{product.productName}</span></td><td className="px-4">{product.searched}</td><td className="px-4">{product.recommended}</td><td className="px-4">{product.selected}</td><td className="px-4">{product.orders}</td><td className="px-4">{product.orderQuantity}</td><td className="px-4"><Badge tone={product.currentStock > 0 ? 'green' : product.isPreOrder ? 'amber' : 'red'}>{product.currentStock > 0 ? product.currentStock : product.isPreOrder ? 'Pre-order' : 'Out'}</Badge></td><td className="px-4">৳{product.currentPrice}</td></tr>)}</tbody></table>{products.length === 0 ? <p className="p-8 text-center text-sm text-stone-500">No product events in this period.</p> : null}</div></section>
      <section className="grid gap-6 lg:grid-cols-3"><List title="Top searched" rows={overview.trends.topSearchedProducts.map((item) => [item.productCode, item.searched])}/><List title="Popular categories" rows={overview.trends.popularCategories.map((item) => [item.category, item.count])}/><List title="Requested sizes" rows={overview.trends.commonRequestedSizes.map((item) => [item.size, item.count])}/></section>
    </div> : null}
  </main>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4"/>{label}</label>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-2xl border bg-white p-5 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>; }
function List({ title, rows }: { title: string; rows: Array<[string, number]> }) { return <div className="rounded-2xl border bg-white p-5"><h3 className="font-semibold">{title}</h3><div className="mt-3 space-y-2">{rows.slice(0, 6).map(([label, value]) => <div key={label} className="flex justify-between text-sm"><span className="truncate pr-3">{label}</span><strong>{value}</strong></div>)}{rows.length === 0 ? <p className="text-sm text-stone-500">No data</p> : null}</div></div>; }
function humanize(value: string) { return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
