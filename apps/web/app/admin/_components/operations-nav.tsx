import Link from 'next/link';

const links = [
  ['Health','/admin/system-health'], ['Queues','/admin/queues'], ['Failed jobs','/admin/failed-jobs'],
  ['AI','/admin/ai-monitoring'], ['Messenger','/admin/messenger-health'], ['Product sync','/admin/product-sync'],
  ['Activity','/admin/activity-log'],
] as const;
export function OperationsNav({ active }: { active: string }) {
  return <nav aria-label="Operations" className="mt-4 flex gap-2 overflow-x-auto pb-1">{links.map(([label,href])=><Link key={href} href={href} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${active===href?'bg-stone-900 text-white':'border bg-white'}`}>{label}</Link>)}</nav>;
}
