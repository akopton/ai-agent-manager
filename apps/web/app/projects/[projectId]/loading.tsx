const ProjectLoading = () => (
  <div role="status" aria-live="polite" className="space-y-6">
    <span className="sr-only">Loading project…</span>
    <div className="space-y-3" aria-hidden="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <div className="h-4 w-80 max-w-full animate-pulse rounded bg-muted" />
    </div>
    <div className="grid gap-3" aria-hidden="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-24 animate-pulse rounded-xl bg-muted/70" />
      ))}
    </div>
  </div>
);

export default ProjectLoading;
