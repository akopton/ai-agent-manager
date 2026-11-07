'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import {
  activeProjectSection,
  projectWorkspaceLinks,
  readWorkspaceMemory,
  rememberWorkspaceLocation,
  workspaceMemoryKey,
  type WorkspaceMemory,
} from '@/lib/projects/workspace-navigation';
import { cn } from '@/lib/utils';

const memoryEvent = 'project-navigation-change';
const subscribe = (listener: () => void) => {
  window.addEventListener(memoryEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(memoryEvent, listener);
    window.removeEventListener('storage', listener);
  };
};
const readStored = (key: string): string => {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const serverSnapshot = () => '';

export const ProjectWorkspaceLinks = ({
  projectId,
  pathname,
  memory = {},
}: {
  projectId: string;
  pathname: string;
  memory?: WorkspaceMemory;
}) => (
  <nav aria-label="Project workspace" className="flex flex-wrap gap-1">
    {projectWorkspaceLinks(projectId).map(({ key, label, href }) => {
      const active = activeProjectSection(projectId, pathname) === key;
      const destination =
        key === 'kanban' ? memory.board : key === 'conversations' ? memory.conversation : undefined;
      return (
        <Link
          key={key}
          href={destination ?? href}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'cursor-pointer rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
            active
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground',
          )}
        >
          {label}
        </Link>
      );
    })}
  </nav>
);

export const ProjectWorkspaceNav = ({ projectId }: { projectId: string }) => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = workspaceMemoryKey(projectId);
  const stored = useSyncExternalStore(subscribe, () => readStored(key), serverSnapshot);
  const memory = readWorkspaceMemory(projectId, stored);

  useEffect(() => {
    try {
      const next = JSON.stringify(
        rememberWorkspaceLocation(
          projectId,
          readWorkspaceMemory(projectId, readStored(key)),
          pathname,
          search,
        ),
      );
      if (next === readStored(key)) return;
      window.sessionStorage.setItem(key, next);
      window.dispatchEvent(new Event(memoryEvent));
    } catch {
      // Navigation remains available when browser storage is blocked.
    }
  }, [projectId, key, pathname, search]);

  return <ProjectWorkspaceLinks projectId={projectId} pathname={pathname} memory={memory} />;
};
