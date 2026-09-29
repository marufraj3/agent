import Link from 'next/link';

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-stone-100/70">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-stone-900 text-xs font-bold tracking-wider text-white">
              AF
            </span>
            <div>
              <p className="font-semibold text-stone-900">Alzeena Fashion</p>
              <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Admin</p>
            </div>
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm font-medium">
            {([
              ['Knowledge Base', '/admin/knowledge-base'],
              ['Settings', '/admin/settings'],
              ['AI Test', '/admin/ai-test'],
              ['Customers', '/admin/customers'],
              ['Conversations', '/admin/conversations'],
              ['Orders', '/admin/orders'],
            ] as const).map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="rounded-full px-3 py-2 text-stone-700 transition hover:bg-stone-100 hover:text-stone-950"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
