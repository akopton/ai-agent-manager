import {
  ConversationError,
  evaluateProjectSourceAccess,
  projectIdSchema,
  projectSourceAccessInputSchema,
  projectSourceDisclosure,
  sourceRepositoryIdentitySchema,
  type ProjectSourceAccessDecision,
} from '@ai-agent-manager/core';
import { eq } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import type { Transaction } from './conversations.js';
import { projects } from './schema.js';

// C4 — the per-project permission to share repository content with AI Conversations. It is
// separate from the AI Conversations consent (`conversation_settings`) and from Trusted Local
// execution trust (`projects.execution_trust`): none of them implies another. Nothing here reads a
// repository; the web layer verifies the repository identity before a grant is stored.

type Database = DatabaseConnection['db'];

export type ProjectSourceAccessRecord = Pick<
  typeof projects.$inferSelect,
  | 'id'
  | 'gitCommonDir'
  | 'conversationSourceAccess'
  | 'conversationSourceCommonDir'
  | 'conversationSourceDisclosureVersion'
  | 'conversationSourceAllowedAt'
  | 'conversationSourceIdentity'
>;

const columns = {
  id: projects.id,
  conversationSourceIdentity: projects.conversationSourceIdentity,
  gitCommonDir: projects.gitCommonDir,
  conversationSourceAccess: projects.conversationSourceAccess,
  conversationSourceCommonDir: projects.conversationSourceCommonDir,
  conversationSourceDisclosureVersion: projects.conversationSourceDisclosureVersion,
  conversationSourceAllowedAt: projects.conversationSourceAllowedAt,
};

export const findProjectSourceAccess = (
  db: Database | Transaction,
  projectId: string,
): ProjectSourceAccessRecord | undefined => {
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) return undefined;
  return db.select(columns).from(projects).where(eq(projects.id, parsed.data)).get();
};

/** The persisted decision for a project; a missing project is "not allowed". */
export const evaluateStoredProjectSourceAccess = (
  db: Database | Transaction,
  projectId: string,
): ProjectSourceAccessDecision => {
  const record = findProjectSourceAccess(db, projectId);
  if (record === undefined) {
    return { ok: false, reason: 'not_allowed', message: 'The project does not exist.' };
  }
  return evaluateProjectSourceAccess(record);
};

/**
 * Refuses a Project-Aware request unless the project's source-sharing permission is current.
 *
 * @internal Shared with `conversation-turns.ts`.
 */
export const requireProjectSourceAccess = (tx: Transaction, projectId: string): void => {
  const decision = evaluateStoredProjectSourceAccess(tx, projectId);
  if (!decision.ok) {
    throw new ConversationError('conversation_source_access_required', decision.message, {
      reason: decision.reason,
    });
  }
};

/**
 * Stores the operator's grant (bound to the registered common Git directory and the current
 * disclosure) or its withdrawal. The caller must have verified that the repository at the
 * registered path still has this identity. Returns the stored record, or `undefined` for an
 * unknown project.
 */
export const setProjectSourceAccess = (
  db: Database,
  {
    projectId,
    input,
    now,
    repositoryIdentity,
  }: { projectId: string; input: unknown; now: number; repositoryIdentity?: unknown },
): ProjectSourceAccessRecord | undefined => {
  const parsed = projectSourceAccessInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConversationError(
      'invalid_conversation_input',
      parsed.error.issues[0]?.message ?? 'The source-sharing request is invalid.',
    );
  }
  const data = parsed.data;
  return db.transaction(
    (tx) => {
      const current = findProjectSourceAccess(tx, projectId);
      if (current === undefined) return undefined;
      if (data.access === 'allowed') {
        if (data.disclosureVersion !== projectSourceDisclosure.version) {
          throw new ConversationError(
            'conversation_changed',
            'The source-sharing disclosure you accepted is not the current one. Reload the page and read it again.',
          );
        }
        if (data.gitCommonDir !== current.gitCommonDir) {
          throw new ConversationError(
            'conversation_changed',
            'The confirmed repository differs from the registered project. Reload the page.',
          );
        }
      }
      return tx
        .update(projects)
        .set(
          data.access === 'allowed'
            ? {
                conversationSourceAccess: 'allowed',
                conversationSourceIdentity: JSON.stringify(
                  sourceRepositoryIdentitySchema.parse(repositoryIdentity),
                ),
                conversationSourceCommonDir: current.gitCommonDir,
                conversationSourceDisclosureVersion: projectSourceDisclosure.version,
                conversationSourceAllowedAt: now,
              }
            : {
                conversationSourceAccess: 'none',
                conversationSourceIdentity: null,
                conversationSourceCommonDir: null,
                conversationSourceDisclosureVersion: null,
                conversationSourceAllowedAt: null,
              },
        )
        .where(eq(projects.id, current.id))
        .returning(columns)
        .get();
    },
    { behavior: 'immediate' },
  );
};
