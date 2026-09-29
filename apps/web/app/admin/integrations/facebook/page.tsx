'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../../_components/admin-access';
import { adminRequest, useAdminPassword } from '../../_lib/admin-client';

type FacebookStatus = {
  connected: boolean; pageId: string | null; graphApiVersion: string; webhookConfigured: boolean;
  lastWebhookAt: string | null; lastOutboundMessageAt: string | null; lastError: string | null;
};

export default function FacebookIntegrationPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [status, setStatus] = useState<FacebookStatus>();
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const attempted = useRef(false);
  const load = useCallback(async () => {
    if (!password) return; setLoading(true); setError('');
    try { const result = await adminRequest<{ success: true; data: FacebookStatus }>('/admin/integrations/facebook/status', password); setStatus(result.data); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load Facebook status.'); }
    finally { setLoading(false); }
  }, [password]);
  useEffect(() => { if (hydrated && !attempted.current) { attempted.current = true; if (password) void load(); } }, [hydrated, password, load]);
  return <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
    <h1 className="text-4xl font-semibold tracking-tight">Facebook Messenger</h1>
    <p className="mb-8 mt-2 text-stone-600">Connection health only. Access tokens, app secrets, and verify tokens are never displayed.</p>
    <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => void load()} loading={loading}/>
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-700">{error}</p> : null}
    {status ? <div className="mt-6 grid gap-4 sm:grid-cols-2">
      <Card label="Connection" value={status.connected ? 'Configured' : 'Not configured'} good={status.connected}/>
      <Card label="Webhook security" value={status.webhookConfigured ? 'Configured' : 'Not configured'} good={status.webhookConfigured}/>
      <Card label="Page ID" value={status.pageId ?? 'Not configured'}/>
      <Card label="Graph API" value={status.graphApiVersion}/>
      <Card label="Last webhook" value={status.lastWebhookAt ? new Date(status.lastWebhookAt).toLocaleString() : 'None received'}/>
      <Card label="Last successful outbound" value={status.lastOutboundMessageAt ? new Date(status.lastOutboundMessageAt).toLocaleString() : 'None sent'}/>
      <div className="sm:col-span-2"><Card label="Last delivery/processing error" value={status.lastError ?? 'No recorded errors'} good={!status.lastError}/></div>
    </div> : null}
  </main>;
}
function Card({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-stone-400">{label}</p><p className={`mt-2 font-semibold ${good === true ? 'text-emerald-700' : good === false ? 'text-amber-700' : 'text-stone-900'}`}>{value}</p></section>;
}
