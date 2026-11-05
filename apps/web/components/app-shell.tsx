import type { ReactNode } from 'react';
import { Monitor } from 'lucide-react';

import { MainNav } from '@/components/main-nav';
import { Badge } from '@/components/ui/badge';

export const AppShell = ({ children }: { children: ReactNode }) => (
  <div className="min-h-svh bg-muted/30 md:grid md:grid-cols-[15rem_1fr]">
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3 focus:ring-2 focus:ring-ring"
    >
      Skip to content
    </a>
    <aside className="flex flex-col border-b bg-sidebar text-sidebar-foreground md:min-h-svh md:border-r md:border-b-0">
      <div className="flex items-center gap-3 px-5 py-6">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-primary-foreground"
          aria-hidden="true"
        >
          AM
        </span>
        <div>
          <p className="text-sm font-semibold tracking-tight">AI Agent Manager</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Your local workspace</p>
        </div>
      </div>
      <MainNav />
      <div className="mt-auto hidden border-t px-5 py-5 text-xs text-muted-foreground md:block">
        <div className="flex items-center gap-2">
          <Monitor className="size-3.5" aria-hidden="true" />
          Built for your machine
        </div>
      </div>
    </aside>
    <div className="min-w-0">
      <header className="flex h-16 items-center justify-between gap-4 border-b bg-background px-6 lg:px-10">
        <p className="text-sm font-medium">Workspace</p>
        <Badge variant="outline" className="gap-2">
          <span className="size-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
          Local workspace
        </Badge>
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
