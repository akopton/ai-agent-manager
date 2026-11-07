import Link from 'next/link';
import type { RecentProject } from '@ai-agent-manager/database';
import { formatTimestamp } from '@/lib/projects/format';

export const RecentProjects = ({ projects }: { projects: readonly RecentProject[] }) =>
  projects.length === 0 ? (
    <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
      No projects yet. Add a local repository to get started.
    </p>
  ) : (
    <ul className="grid gap-4 sm:grid-cols-2">
      {projects.map((project) => (
        <li key={project.id} className="min-w-0">
          <Link
            href={`/projects/${project.id}`}
            className="block h-full cursor-pointer space-y-3 rounded-xl border bg-card p-5 outline-none transition-colors hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <h3 className="font-semibold break-words">{project.name}</h3>
            <p className="text-sm text-muted-foreground">{project.activity}</p>
            <time
              dateTime={new Date(project.activityAt).toISOString()}
              className="block text-xs text-muted-foreground"
            >
              {formatTimestamp(project.activityAt)}
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
