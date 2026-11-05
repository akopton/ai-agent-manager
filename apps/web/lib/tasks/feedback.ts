import { taskUrl } from '@/lib/tasks/board';

// One-time success messages are passed to the next page in the URL, as for projects.

type SearchParams = Record<string, string | string[] | undefined>;

export type TaskFeedback = 'created' | 'saved';

export const createdTaskUrl = (projectId: string, taskId: string): string =>
  `${taskUrl(projectId, taskId)}?created=1`;

export const savedTaskUrl = (projectId: string, taskId: string): string =>
  `${taskUrl(projectId, taskId)}?saved=1`;

export const readTaskFeedback = (searchParams: SearchParams): TaskFeedback | undefined => {
  if (searchParams.created === '1') {
    return 'created';
  }
  return searchParams.saved === '1' ? 'saved' : undefined;
};
