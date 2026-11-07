import { projectIdSchema } from '@ai-agent-manager/core';
import { z } from 'zod';

export type ProjectSection = 'overview' | 'kanban' | 'conversations' | 'settings';

export const projectWorkspaceLinks = (projectId: string) => {
  const root = `/projects/${encodeURIComponent(projectId)}`;
  return [
    { key: 'overview', label: 'Overview', href: root },
    { key: 'kanban', label: 'Kanban', href: `${root}/board` },
    { key: 'conversations', label: 'Conversations', href: `${root}/conversations` },
    { key: 'settings', label: 'Settings', href: `${root}/settings` },
  ] as const;
};

export const activeProjectSection = (
  projectId: string,
  pathname: string,
): ProjectSection | undefined => {
  const root = projectWorkspaceLinks(projectId)[0].href;
  if (pathname === root) return 'overview';
  if (!pathname.startsWith(`${root}/`)) return undefined;
  const section = pathname.slice(root.length + 1).split('/')[0];
  if (section === 'board' || section === 'tasks') return 'kanban';
  if (section === 'conversations') return 'conversations';
  if (section === 'settings' || section === 'edit') return 'settings';
  return undefined;
};

export const workspaceMemoryKey = (projectId: string): string =>
  `ai-agent-manager:project-navigation:${projectId}`;

const memorySchema = z.object({
  board: z.string().optional(),
  conversation: z.string().optional(),
});
export type WorkspaceMemory = z.infer<typeof memorySchema>;

/** Stored browser data is untrusted: accept only exact same-project destinations. */
export const readWorkspaceMemory = (projectId: string, stored: string): WorkspaceMemory => {
  try {
    const parsed = memorySchema.safeParse(JSON.parse(stored));
    if (!parsed.success) return {};
    const root = projectWorkspaceLinks(projectId)[0].href;
    const { board, conversation } = parsed.data;
    const boardPath = board?.split('?')[0];
    const conversationPrefix = `${root}/conversations/`;
    return {
      board: boardPath === `${root}/board` && !board?.includes('#') ? board : undefined,
      conversation:
        conversation?.startsWith(conversationPrefix) &&
        projectIdSchema.safeParse(conversation.slice(conversationPrefix.length)).success
          ? conversation
          : undefined,
    };
  } catch {
    return {};
  }
};

export const rememberWorkspaceLocation = (
  projectId: string,
  memory: WorkspaceMemory,
  pathname: string,
  search: string,
): WorkspaceMemory => {
  const candidate = readWorkspaceMemory(
    projectId,
    JSON.stringify({
      board: pathname + (search ? `?${search}` : ''),
      conversation: pathname,
    }),
  );
  return {
    board: candidate.board ?? memory.board,
    conversation: candidate.conversation ?? memory.conversation,
  };
};
