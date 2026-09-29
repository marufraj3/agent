"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const navigation = [
  { label: "Dashboard", href: "/admin" },
  { label: "Inbox", href: "/admin/inbox" },
  { label: "Customers", href: "/admin/customers" },
  { label: "Orders", href: "/admin/orders" },
  { label: "Automation", href: "/admin/automation/followups" },
  { label: "Products", href: "/admin/products" },
  { label: "Knowledge Base", href: "/admin/knowledge-base" },
  { label: "Settings", href: "/admin/settings" },
  { label: "System", href: "/admin/system" },
] as const;

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  function logout() {
    sessionStorage.removeItem("alzeena-admin-password");
    router.push("/admin");
    router.refresh();
  }
  return (
    <div className="min-h-screen bg-stone-100/70 lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-stone-200 bg-stone-950 text-white lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-5 py-5 lg:block">
          <Link href="/admin" className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-amber-700 text-xs font-bold">
              AF
            </span>
            <span>
              <strong className="block">Alzeena Fashion</strong>
              <small className="text-stone-400">Admin Console</small>
            </span>
          </Link>
          <button
            onClick={logout}
            className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-300 lg:hidden"
          >
            Logout
          </button>
        </div>
        <nav
          className="flex gap-1 overflow-x-auto px-3 pb-4 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0"
          aria-label="Admin navigation"
        >
          {navigation.map((item) => {
            const active =
              item.href === "/admin"
                ? pathname === item.href
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium ${active ? "bg-amber-700 text-white" : "text-stone-300 hover:bg-stone-800 hover:text-white"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="absolute bottom-5 hidden w-full px-5 lg:block">
          <p className="mb-3 text-xs text-stone-500">Role: Admin</p>
          <button
            onClick={logout}
            className="w-full rounded-xl border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:bg-stone-800"
          >
            Logout
          </button>
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
