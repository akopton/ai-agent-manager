'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderGit2, LayoutDashboard, MessagesSquare, Settings } from 'lucide-react';

import { activeMainNavKey, type MainNavKey } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const links: { key: MainNavKey; href: string; label: string; icon: typeof Settings }[] = [
  { key: 'overview', href: '/', label: 'Overview', icon: LayoutDashboard },
  { key: 'projects', href: '/projects', label: 'Projects', icon: FolderGit2 },
  { key: 'conversations', href: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { key: 'settings', href: '/settings', label: 'App Settings', icon: Settings },
];

export const MainNav = () => {
  const activeKey = activeMainNavKey(usePathname());

  return (
    <nav aria-label="Main navigation" className="space-y-1 px-3 pb-5">
      <p className="px-3 pt-2 pb-2 text-[0.6875rem] font-medium tracking-wider text-muted-foreground/80 uppercase">
        Workspace
      </p>
      {links.map(({ key, href, label, icon: Icon }) => {
        const active = key === activeKey;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 [&_svg]:size-4 [&_svg]:shrink-0',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground [&_svg]:text-sidebar-primary'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
};
