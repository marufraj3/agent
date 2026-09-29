'use client';

interface AdminAccessProps {
  password: string;
  onPasswordChange: (value: string) => void;
  onLoad: () => void;
  loading: boolean;
}

export function AdminAccess({
  password,
  onPasswordChange,
  onLoad,
  loading,
}: AdminAccessProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row sm:items-end">
      <label className="flex-1 text-sm font-medium text-stone-700">
        Admin password
        <input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onLoad();
          }}
          autoComplete="current-password"
          placeholder="Enter the ADMIN_PASSWORD value"
          className="mt-2 w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-stone-900 outline-none transition focus:border-amber-700 focus:ring-2 focus:ring-amber-700/15"
        />
      </label>
      <button
        type="button"
        onClick={onLoad}
        disabled={loading || !password}
        className="rounded-xl bg-stone-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load admin data'}
      </button>
      <button type="button" onClick={() => onPasswordChange('')} className="rounded-xl border px-4 py-3 text-sm font-semibold text-stone-700">Logout</button>
      <p className="text-xs leading-5 text-stone-500 sm:max-w-48">
        Password is exchanged once for a short-lived HttpOnly, SameSite session cookie and is never stored in browser storage.
      </p>
    </div>
  );
}
