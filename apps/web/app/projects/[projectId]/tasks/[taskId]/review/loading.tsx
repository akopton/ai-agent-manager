const ReviewLoading = () => (
  <div role="status" aria-live="polite" className="space-y-6">
    <span className="sr-only">Inspecting the task worktree…</span>
    <div className="space-y-3" aria-hidden="true">
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="h-8 w-72 max-w-full animate-pulse rounded-lg bg-muted" />
    </div>
    <div className="h-40 animate-pulse rounded-xl bg-muted/70" aria-hidden="true" />
    <div className="h-64 animate-pulse rounded-xl bg-muted/70" aria-hidden="true" />
  </div>
);

export default ReviewLoading;
