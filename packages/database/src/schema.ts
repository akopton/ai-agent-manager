import { agentRuntimes, taskPriorities, taskStatuses } from '@ai-agent-manager/core';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// Constant identifiers from `core`, rendered into CHECK constraints (never user data).
const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * Tasks of a project (ARCHITECTURE §4). Timestamps are Unix milliseconds. `model_id = NULL` means
 * `Default`; `base_branch = NULL` means the project's default base branch. The project reference
 * is `RESTRICT`: a project with tasks cannot be deleted, and tasks are never deleted with it.
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    modelId: text('model_id'),
    baseBranch: text('base_branch'),
    priority: text('priority', { enum: taskPriorities }).notNull().default('normal'),
    urgent: integer('urgent', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: taskStatuses }).notNull().default('backlog'),
    queuedAt: integer('queued_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('tasks_status_queued_at_idx').on(table.status, table.queuedAt),
    index('tasks_project_id_status_idx').on(table.projectId, table.status),
    check('tasks_agent_runtime_check', sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`),
    check('tasks_priority_check', sql`${table.priority} IN (${sqlList(taskPriorities)})`),
    check('tasks_status_check', sql`${table.status} IN (${sqlList(taskStatuses)})`),
    check('tasks_urgent_check', sql`${table.urgent} IN (0, 1)`),
    check(
      'tasks_queued_at_check',
      sql`${table.status} <> 'queued' OR ${table.queuedAt} IS NOT NULL`,
    ),
  ],
);

export const schema = { projects, tasks };
