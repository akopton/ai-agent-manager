import Link from 'next/link';
import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { TaskEditability } from '@/lib/tasks/actions';

/** Reused above and after the prompt, with the same server-derived restrictions. */
export const TaskEditLink = ({
  projectId,
  taskId,
  editability,
}: {
  projectId: string;
  taskId: string;
  editability: TaskEditability;
}) => {
  if (!editability.content && !editability.priority) return null;
  return (
    <Button asChild variant="outline">
      <Link href={`/projects/${projectId}/tasks/${taskId}/edit`}>
        <Pencil aria-hidden="true" />
        {editability.content ? 'Edit task' : 'Change priority'}
      </Link>
    </Button>
  );
};
