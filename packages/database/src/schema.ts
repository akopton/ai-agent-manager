import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Registered local Git repositories. Timestamps are Unix milliseconds. Both the canonical working
 * tree path and the canonical common Git directory are unique, so the same repository cannot be
 * connected twice.
 */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  localPath: text('local_path').notNull().unique(),
  gitCommonDir: text('git_common_dir').notNull().unique(),
  remoteName: text('remote_name'),
  defaultBaseBranch: text('default_base_branch').notNull(),
  // Smaller numbers are scheduled first (ARCHITECTURE §6); the range is validated in `core`.
  priority: integer('priority').notNull().default(0),
  instructions: text('instructions').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const schema = { projects };
