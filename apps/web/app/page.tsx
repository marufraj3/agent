export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <section className="w-full max-w-4xl overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white/80 p-8 shadow-[0_30px_100px_-45px_rgba(67,45,29,0.4)] backdrop-blur sm:p-14">
        <div className="mb-12 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-stone-900 text-sm font-semibold tracking-wider text-white">
            AF
          </span>
          <div>
            <p className="font-semibold tracking-wide text-stone-900">Alzeena Fashion</p>
            <p className="text-sm text-stone-500">Sales Agent</p>
          </div>
        </div>

        <div className="max-w-2xl">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.28em] text-amber-800">
            Foundation ready
          </p>
          <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight text-stone-900 sm:text-6xl">
            A thoughtful new way to shop is taking shape.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-stone-600">
            The technical foundation for Alzeena Fashion&apos;s sales experience is now in place.
            Customer-facing capabilities will arrive in future releases.
          </p>
        </div>

        <div className="mt-14 border-t border-stone-200 pt-6 text-sm text-stone-500">
          Step 1 · Project foundation
        </div>
      </section>
    </main>
  );
}
