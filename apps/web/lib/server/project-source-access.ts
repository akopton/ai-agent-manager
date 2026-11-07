import {
  ConversationError,
  projectIdSchema,
  type ProjectSourceAccessInput,
} from '@ai-agent-manager/core';
import {
  findProjectById,
  setProjectSourceAccess,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
// Read-only identity check; the only Git entry point used here.
import { verifySourceRepository } from '@ai-agent-manager/git/source-context';
import type { ProjectSourceAccessView } from '@/lib/conversations/contracts';
import { toProjectSourceAccessView } from '@/lib/server/conversations';

// C4 — the operator's per-project permission to share repository content with Project-Aware
// conversations. A grant is stored only after the repository at the registered path is verified
// (read-only) to still be the registered repository. It enables nothing else: no task execution,
// no worktree, no Git mutation. It never reads file content.

type Database = DatabaseConnection['db'];

const projectNotFound = (): ConversationError =>
  new ConversationError('project_not_found', 'The project does not exist.');

export const getProjectSourceAccess = (
  db: Database,
  projectId: string,
): ProjectSourceAccessView => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (project === undefined) throw projectNotFound();
  return toProjectSourceAccessView(project);
};

export const updateProjectSourceAccess = async (
  db: Database,
  projectId: string,
  input: ProjectSourceAccessInput,
  { now = Date.now }: { now?: () => number } = {},
): Promise<ProjectSourceAccessView> => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (project === undefined) throw projectNotFound();
  if (input.access === 'allowed') {
    try {
      await verifySourceRepository({
        localPath: project.localPath,
        gitCommonDir: project.gitCommonDir,
      });
    } catch (error) {
      throw new ConversationError(
        'conversation_changed',
        `Source sharing cannot be allowed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const updated = setProjectSourceAccess(db, { projectId: project.id, input, now: now() });
  if (updated === undefined) throw projectNotFound();
  return getProjectSourceAccess(db, project.id);
};
