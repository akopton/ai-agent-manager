import type { ReactNode } from 'react';
import { Monitor } from 'lucide-react';

import { MainNav } from '@/components/main-nav';

export const AppShell = ({ children }: { children: ReactNode }) => (
  <div className="min-h-svh bg-background md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:p-3 focus:ring-2 focus:ring-ring"
    >
      Skip to content
    </a>
    <aside className="flex flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-svh md:overflow-y-auto md:border-r md:border-b-0">
      <div className="flex items-center gap-3 px-5 py-5 md:py-6">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-xs font-semibold tracking-wide text-primary ring-1 ring-primary/25"
          aria-hidden="true"
        >
          AM
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight">AI Agent Manager</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Your local workspace</p>
        </div>
      </div>
      <MainNav />
      <div className="mt-auto hidden border-t border-sidebar-border px-5 py-5 text-xs text-muted-foreground md:block">
        <div className="flex items-center gap-2">
          <Monitor className="size-3.5" aria-hidden="true" />
          Built for your machine
        </div>
      </div>
    </aside>
    <div className="min-w-0">
      <header className="flex h-14 items-center justify-between gap-4 border-b px-6 lg:px-10">
        <p className="text-sm font-medium text-muted-foreground">Workspace</p>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          Local workspace
        </span>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl space-y-8 p-6 outline-none lg:p-10"
      >
        {children}
      </main>
    </div>
  </div>
);
