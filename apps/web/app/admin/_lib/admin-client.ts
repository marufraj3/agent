'use client';

import { useEffect, useState } from 'react';

const PASSWORD_STORAGE_KEY = 'alzeena-admin-password';

export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function adminRequest<T>(
  path: string,
  password: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/backend-api${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      'x-admin-password': password,
      ...init.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
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
    setPasswordState(sessionStorage.getItem(PASSWORD_STORAGE_KEY) ?? '');
    setHydrated(true);
  }, []);

  function setPassword(value: string) {
    setPasswordState(value);
    if (value) sessionStorage.setItem(PASSWORD_STORAGE_KEY, value);
    else sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
  }

  return { password, setPassword, hydrated };
}
