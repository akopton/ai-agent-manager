const BoardLoading = () => (
  <div role="status" aria-live="polite" className="space-y-6">
    <span className="sr-only">Loading board…</span>
    <div className="space-y-3" aria-hidden="true">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-muted" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="h-48 animate-pulse rounded-xl bg-muted/70" />
      ))}
    </div>
  </div>
);

export default BoardLoading;
