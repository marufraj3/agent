'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

interface SettingsData {
  deliveryChargeDhaka: string;
  deliveryChargeOutsideDhaka: string;
  returnDeliveryCharge: string;
  websiteApiBaseUrl: string;
  pageId: string;
  deliveryCompanyId: string;
  utmSource: string;
  utmCampaign: string;
}

type Notice = { type: 'success' | 'error'; text: string } | null;

const initialSettings: SettingsData = {
  deliveryChargeDhaka: '0',
  deliveryChargeOutsideDhaka: '0',
  returnDeliveryCharge: '0',
  websiteApiBaseUrl: 'https://sells.alzeena.com.bd/public/api',
  pageId: '3',
  deliveryCompanyId: '11',
  utmSource: 'AI',
  utmCampaign: 'Order From AI BOT',
};

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'url';
  help?: string;
}

function Field({ label, value, onChange, type = 'text', help }: FieldProps) {
  return (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        min={type === 'number' ? '0' : undefined}
        step={type === 'number' ? '0.01' : undefined}
        className="mt-2 w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-stone-900 outline-none transition focus:border-amber-700 focus:bg-white focus:ring-2 focus:ring-amber-700/15"
      />
      {help ? <span className="mt-1 block text-xs font-normal text-stone-500">{help}</span> : null}
    </label>
  );
}

export default function SettingsPage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [settings, setSettings] = useState<SettingsData>(initialSettings);
  const [loading, setLoading] = useState(false);
  const [savingGroup, setSavingGroup] = useState<'delivery' | 'business' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const autoLoadAttempted = useRef(false);

  const loadSettings = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setNotice(null);
    try {
      const response = await adminRequest<{ success: true; data: SettingsData }>(
        '/admin/settings',
        password,
      );
      setSettings(response.data);
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not load settings.',
      });
    } finally {
      setLoading(false);
    }
  }, [password]);

  useEffect(() => {
    if (!hydrated || autoLoadAttempted.current) return;
    autoLoadAttempted.current = true;
    if (password) void loadSettings();
  }, [hydrated, password, loadSettings]);

  function update<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save(group: 'delivery' | 'business') {
    setSavingGroup(group);
    setNotice(null);
    const body =
      group === 'delivery'
        ? {
            deliveryChargeDhaka: settings.deliveryChargeDhaka,
            deliveryChargeOutsideDhaka: settings.deliveryChargeOutsideDhaka,
            returnDeliveryCharge: settings.returnDeliveryCharge,
          }
        : {
            websiteApiBaseUrl: settings.websiteApiBaseUrl,
            pageId: settings.pageId,
            deliveryCompanyId: settings.deliveryCompanyId,
            utmSource: settings.utmSource,
            utmCampaign: settings.utmCampaign,
          };

    try {
      const response = await adminRequest<{
        success: true;
        message: string;
        data: SettingsData;
      }>('/admin/settings', password, { method: 'PUT', body: JSON.stringify(body) });
      setSettings(response.data);
      setNotice({ type: 'success', text: response.message });
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not save settings.',
      });
    } finally {
      setSavingGroup(null);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="mb-8 max-w-3xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">
          Business configuration
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-950">Settings</h1>
        <p className="mt-4 text-base leading-7 text-stone-600">
          Configure non-sensitive delivery and order attribution values. API keys, access tokens,
          app secrets and passwords remain environment variables and are never returned here.
        </p>
      </div>

      <AdminAccess
        password={password}
        onPasswordChange={setPassword}
        onLoad={() => void loadSettings()}
        loading={loading}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-stone-950">Delivery Settings</h2>
            <p className="mt-1 text-sm text-stone-500">Charges are stored in BDT.</p>
          </div>
          <div className="space-y-5">
            <Field
              label="Dhaka Delivery Charge"
              type="number"
              value={settings.deliveryChargeDhaka}
              onChange={(value) => update('deliveryChargeDhaka', value)}
            />
            <Field
              label="Outside Dhaka Delivery Charge"
              type="number"
              value={settings.deliveryChargeOutsideDhaka}
              onChange={(value) => update('deliveryChargeOutsideDhaka', value)}
            />
            <Field
              label="Return Delivery Charge"
              type="number"
              value={settings.returnDeliveryCharge}
              onChange={(value) => update('returnDeliveryCharge', value)}
            />
          </div>
          <button
            type="button"
            onClick={() => void save('delivery')}
            disabled={!password || savingGroup !== null || loading}
            className="mt-7 rounded-xl bg-amber-800 px-6 py-3 text-sm font-semibold text-white transition hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingGroup === 'delivery' ? 'Saving…' : 'Save Delivery Settings'}
          </button>
        </section>

        <section className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-stone-950">Order / API Settings</h2>
            <p className="mt-1 text-sm text-stone-500">Non-secret identifiers and attribution.</p>
          </div>
          <div className="space-y-5">
            <Field
              label="Website API Base URL"
              type="url"
              value={settings.websiteApiBaseUrl}
              onChange={(value) => update('websiteApiBaseUrl', value)}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Page ID" value={settings.pageId} onChange={(value) => update('pageId', value)} />
              <Field
                label="Delivery Company ID"
                value={settings.deliveryCompanyId}
                onChange={(value) => update('deliveryCompanyId', value)}
              />
            </div>
            <Field
              label="UTM Source"
              value={settings.utmSource}
              onChange={(value) => update('utmSource', value)}
            />
            <Field
              label="UTM Campaign"
              value={settings.utmCampaign}
              onChange={(value) => update('utmCampaign', value)}
            />
          </div>
          <button
            type="button"
            onClick={() => void save('business')}
            disabled={!password || savingGroup !== null || loading}
            className="mt-7 rounded-xl bg-stone-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingGroup === 'business' ? 'Saving…' : 'Save Order / API Settings'}
          </button>
        </section>
      </div>

      <div className="mt-5 min-h-6" aria-live="polite">
        {notice ? (
          <p
            className={`text-sm font-medium ${notice.type === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {notice.text}
          </p>
        ) : null}
      </div>
    </main>
  );
}
