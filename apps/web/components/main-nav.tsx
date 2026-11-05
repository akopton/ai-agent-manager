'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderGit2, LayoutDashboard, Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';

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
      <p className="px-3 pt-2 pb-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Workspace
      </p>
      {links.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Button
            key={href}
            asChild
            variant={active ? 'secondary' : 'ghost'}
            className="h-10 w-full justify-start gap-3"
          >
            <Link href={href} aria-current={active ? 'page' : undefined}>
              <Icon aria-hidden="true" />
              {label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
};
