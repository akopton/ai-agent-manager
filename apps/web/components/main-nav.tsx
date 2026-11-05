'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderGit2, LayoutDashboard, Settings } from 'lucide-react';

import { cn } from '@/lib/utils';

const isActive = (pathname: string, href: string): boolean =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

const links = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderGit2 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export const MainNav = () => {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="space-y-1 px-3 pb-5">
      <p className="px-3 pt-2 pb-2 text-[0.6875rem] font-medium tracking-wider text-muted-foreground/80 uppercase">
        Workspace
      </p>
      {links.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
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
