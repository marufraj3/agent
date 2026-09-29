'use client';

import { useEffect, useState } from 'react';

const SESSION_STORAGE_KEY = 'alzeena-admin-session';
const SESSION_MARKER = '••••••••';
let sessionReady = false;

export class AdminApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function ensureSession(password: string): Promise<void> {
  if (
    sessionReady ||
    password === SESSION_MARKER ||
    (typeof window !== 'undefined' && sessionStorage.getItem(SESSION_STORAGE_KEY) === 'active')
  ) {
    sessionReady = true;
    return;
  }

  const response = await fetch('/backend-api/admin/session', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new AdminApiError(
      response.status === 429 ? 'Too many login attempts. Please try again later.' : 'Unauthorized',
      response.status,
    );
  }

  sessionReady = true;
  sessionStorage.setItem(SESSION_STORAGE_KEY, 'active');
  window.dispatchEvent(new Event('admin-session-ready'));
}

export async function adminRequest<T>(
  path: string,
  password: string,
  init: RequestInit = {},
): Promise<T> {
  await ensureSession(password);
  const response = await fetch(`/backend-api${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      sessionReady = false;
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      if (window.location.pathname !== '/admin') window.location.assign('/admin');
    }
    throw new AdminApiError(
      payload?.error?.message ?? `Admin request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

export function useAdminPassword() {
  const [password, setPasswordState] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const active = sessionStorage.getItem(SESSION_STORAGE_KEY) === 'active';
    sessionReady = active;
    setPasswordState(active ? SESSION_MARKER : '');
    setHydrated(true);
    const ready = () => setPasswordState(SESSION_MARKER);
    window.addEventListener('admin-session-ready', ready);
    return () => window.removeEventListener('admin-session-ready', ready);
  }, []);

  function setPassword(value: string) {
    setPasswordState(value);
    if (!value) {
      sessionReady = false;
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      void fetch('/backend-api/admin/session', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    }
  }

  return { password, setPassword, hydrated };
}
