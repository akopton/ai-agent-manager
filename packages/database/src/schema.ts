import {
  activePublicationStatuses,
  activeTaskRunStatuses,
  agentRuntimes,
  executionSecurityModes,
  gitIntegrityResultStatuses,
  gitOperationKinds,
  gitOperationStatuses,
  projectExecutionTrusts,
  publicationFailureStages,
  publicationStatuses,
  reviewStatuses,
  taskPriorities,
  taskRunStatuses,
  taskStatuses,
} from '@ai-agent-manager/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
  // SEC-02 execution trust (migration 0003). `trusted_local` is valid only together with the
  // common Git directory the operator trusted and the time of that decision; the worker also
  // requires the trusted common dir to equal `git_common_dir`. Validated in `core`.
  executionTrust: text('execution_trust', { enum: projectExecutionTrusts })
    .notNull()
    .default('none'),
  executionTrustedCommonDir: text('execution_trusted_common_dir'),
  executionTrustedAt: integer('execution_trusted_at'),
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

const activeRunCondition = sql.raw(
  `status IN (${activeTaskRunStatuses.map((value) => `'${value}'`).join(', ')})`,
);

/**
 * Operator security settings (single row, `id = 1`). Trusted Local Mode is off until the operator
 * accepts the current disclosure; disabling clears the acceptance. Timestamps are Unix ms.
 */
export const securitySettings = sqliteTable(
  'security_settings',
  {
    id: integer('id').primaryKey(),
    trustedLocalEnabled: integer('trusted_local_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    trustedLocalDisclosureVersion: text('trusted_local_disclosure_version'),
    trustedLocalAcceptedAt: integer('trusted_local_accepted_at'),
    /** JSON array of accepted `SecurityControl`s. */
    trustedLocalAcceptedRisksJson: text('trusted_local_accepted_risks_json'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('security_settings_singleton_check', sql`${table.id} = 1`),
    check('security_settings_enabled_check', sql`${table.trustedLocalEnabled} IN (0, 1)`),
    check(
      'security_settings_acceptance_check',
      sql`${table.trustedLocalEnabled} = 0 OR (${table.trustedLocalDisclosureVersion} IS NOT NULL AND ${table.trustedLocalAcceptedAt} IS NOT NULL AND ${table.trustedLocalAcceptedRisksJson} IS NOT NULL)`,
    ),
  ],
);

/**
 * Task worktrees created by the worker (ARCHITECTURE §4). Identity is recorded explicitly and
 * never inferred from directory names. Rows are never deleted with a status change; the worktree
 * itself is retained until an explicit cleanup action exists.
 */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    generation: integer('generation').notNull(),
    repositoryRoot: text('repository_root').notNull(),
    gitCommonDir: text('git_common_dir').notNull(),
    worktreeRoot: text('worktree_root').notNull(),
    path: text('path').notNull().unique(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha').notNull(),
    status: text('status', { enum: ['retained'] })
      .notNull()
      .default('retained'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('workspaces_task_generation_unique').on(table.taskId, table.generation),
    check('workspaces_status_check', sql`${table.status} IN ('retained')`),
  ],
);

/**
 * One execution attempt of a task (ARCHITECTURE §4, §5.2, §7.5). The run status, the agent's
 * process outcome and the Git integrity result are stored separately. At most one active run per
 * task and per agent runtime is enforced by partial unique indexes, in addition to the check in
 * the claim transaction. Timestamps are Unix ms; JSON columns are bounded by the writer.
 */
export const taskRuns = sqliteTable(
  'task_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    attempt: integer('attempt').notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    requestedModelId: text('requested_model_id'),
    effectiveModelId: text('effective_model_id'),
    status: text('status', { enum: taskRunStatuses }).notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    securityMode: text('security_mode', { enum: executionSecurityModes }).notNull(),
    disclosureVersion: text('disclosure_version'),
    launchProfileId: text('launch_profile_id'),
    cliVersion: text('cli_version'),
    authorizationId: text('authorization_id'),
    controlAssessmentJson: text('control_assessment_json'),
    acceptedRisksJson: text('accepted_risks_json'),
    safeguardsJson: text('safeguards_json'),
    processContainment: text('process_containment'),
    timeoutMs: integer('timeout_ms').notNull(),
    workerInstanceId: text('worker_instance_id').notNull(),
    pid: integer('pid'),
    sessionId: text('session_id'),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    lingeringProcesses: text('lingering_processes'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    summary: text('summary'),
    stopRequestedAt: integer('stop_requested_at'),
    gitIntegrityStatus: text('git_integrity_status', { enum: gitIntegrityResultStatuses })
      .notNull()
      .default('not_run'),
    gitIntegrityBaselineJson: text('git_integrity_baseline_json'),
    gitIntegrityResultJson: text('git_integrity_result_json'),
    gitIntegrityCheckedAt: integer('git_integrity_checked_at'),
    eventsDropped: integer('events_dropped').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('task_runs_task_attempt_unique').on(table.taskId, table.attempt),
    index('task_runs_status_idx').on(table.status),
    uniqueIndex('task_runs_one_active_per_task_idx').on(table.taskId).where(activeRunCondition),
    uniqueIndex('task_runs_one_active_per_runtime_idx')
      .on(table.agentRuntime)
      .where(activeRunCondition),
    check(
      'task_runs_agent_runtime_check',
      sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`,
    ),
    check('task_runs_status_check', sql`${table.status} IN (${sqlList(taskRunStatuses)})`),
    check(
      'task_runs_security_mode_check',
      sql`${table.securityMode} IN (${sqlList(executionSecurityModes)})`,
    ),
    check(
      'task_runs_git_integrity_status_check',
      sql`${table.gitIntegrityStatus} IN (${sqlList(gitIntegrityResultStatuses)})`,
    ),
    check('task_runs_attempt_check', sql`${table.attempt} >= 1`),
  ],
);

/** Normalized, size-bounded and redacted run events. `sequence` is unique per run. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [unique('run_events_run_sequence_unique').on(table.runId, table.sequence)],
);

/**
 * Operator commands for the worker (M2-03). The web process records intent; the worker claims and
 * executes it. At most one pending start command per task.
 */
export const workerCommands = sqliteTable(
  'worker_commands',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['start_task'] }).notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] }).notNull(),
    runId: text('run_id').references(() => taskRuns.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    resultCode: text('result_code'),
    resultMessage: text('result_message'),
    createdAt: integer('created_at').notNull(),
    processedAt: integer('processed_at'),
  },
  (table) => [
    index('worker_commands_status_created_idx').on(table.status, table.createdAt),
    uniqueIndex('worker_commands_one_pending_per_task_idx')
      .on(table.taskId)
      .where(sql`status = 'pending'`),
    check('worker_commands_kind_check', sql`${table.kind} IN ('start_task')`),
    check(
      'worker_commands_status_check',
      sql`${table.status} IN ('pending', 'accepted', 'rejected')`,
    ),
  ],
);

/**
 * Single-worker lease (`id = 1`). Only the holder claims commands and reconciles runs; a second
 * worker refuses to start while the lease is live.
 */
export const workerLeases = sqliteTable(
  'worker_leases',
  {
    id: integer('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    pid: integer('pid').notNull(),
    acquiredAt: integer('acquired_at').notNull(),
    heartbeatAt: integer('heartbeat_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [check('worker_leases_singleton_check', sql`${table.id} = 1`)],
);

/**
 * Review decisions (ARCHITECTURE §4, M6-02). Each row is a decision about one run (attempt) and the
 * workspace it ran in; at most one decision per run. `changes_requested` keeps the reviewer's
 * feedback for the next attempt, which continues in the same workspace: `follow_up_run_id` is set
 * when the worker claims that attempt. At most one change request per task waits for a follow-up.
 * `inventory_revision` is the change-inventory revision the reviewer saw (not a publish snapshot;
 * the snapshot hash for Approve & Push is a later slice). Rows are never deleted or overwritten.
 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    runId: text('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    status: text('status', { enum: reviewStatuses }).notNull(),
    feedback: text('feedback').notNull(),
    inventoryRevision: text('inventory_revision').notNull(),
    followUpRunId: text('follow_up_run_id').references(() => taskRuns.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('reviews_run_unique').on(table.runId),
    index('reviews_task_id_idx').on(table.taskId),
    uniqueIndex('reviews_follow_up_run_unique')
      .on(table.followUpRunId)
      .where(sql`follow_up_run_id IS NOT NULL`),
    uniqueIndex('reviews_one_pending_change_request_per_task_idx')
      .on(table.taskId)
      .where(sql`status = 'changes_requested' AND follow_up_run_id IS NULL`),
    check('reviews_status_check', sql`${table.status} IN (${sqlList(reviewStatuses)})`),
    check('reviews_feedback_check', sql`length(trim(${table.feedback})) > 0`),
  ],
);

const activePublicationCondition = sql.raw(
  `status IN (${activePublicationStatuses.map((value) => `'${value}'`).join(', ')})`,
);

/**
 * Approve & Push (M6-03, migration `0005_publications`). One row per operator approval: the
 * decision about one run and its workspace, the immutable review snapshot it is bound to
 * (`snapshot_hash` over `snapshot_json`, plus the change-inventory revision the operator saw), the
 * destination resolved by the server, and the durable publish state the worker advances. The
 * documented `reviews.snapshot_*` columns live here instead: `reviews.status` has a CHECK that
 * only an additive table can extend. At most one active publication per task (partial unique
 * index); `request_id` deduplicates repeated submissions. Rows are never deleted.
 */
export const publications = sqliteTable(
  'publications',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().unique(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    runId: text('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    status: text('status', { enum: publicationStatuses }).notNull(),
    failureStage: text('failure_stage', { enum: publicationFailureStages }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    inventoryRevision: text('inventory_revision').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    fileCount: integer('file_count').notNull(),
    baseCommit: text('base_commit').notNull(),
    branch: text('branch').notNull(),
    remoteName: text('remote_name').notNull(),
    /** Display form of the push URL with HTTP(S) credentials redacted. */
    remoteUrl: text('remote_url').notNull(),
    remoteUrlDigest: text('remote_url_digest').notNull(),
    commitMessage: text('commit_message').notNull(),
    commitSha: text('commit_sha'),
    treeSha: text('tree_sha'),
    workerInstanceId: text('worker_instance_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    committedAt: integer('committed_at'),
    pushedAt: integer('pushed_at'),
  },
  (table) => [
    index('publications_task_id_idx').on(table.taskId),
    index('publications_status_idx').on(table.status),
    uniqueIndex('publications_one_active_per_task_idx')
      .on(table.taskId)
      .where(activePublicationCondition),
    check('publications_status_check', sql`${table.status} IN (${sqlList(publicationStatuses)})`),
    check(
      'publications_failure_stage_check',
      sql`(${table.status} = 'failed') = (${table.failureStage} IS NOT NULL) AND (${table.failureStage} IS NULL OR ${table.failureStage} IN (${sqlList(publicationFailureStages)}))`,
    ),
    check(
      'publications_commit_check',
      sql`${table.status} NOT IN ('committed', 'push_requested', 'pushing', 'pushed') OR ${table.commitSha} IS NOT NULL`,
    ),
    check('publications_file_count_check', sql`${table.fileCount} >= 1`),
  ],
);

/**
 * The Git operations of a publication (`ARCHITECTURE.md` §4): the commit and each push attempt,
 * with their own outcome, so a failed push is visible next to the successful commit and a retry is
 * a new push row, never a new commit. At most one running operation per publication.
 */
export const gitOperations = sqliteTable(
  'git_operations',
  {
    id: text('id').primaryKey(),
    publicationId: text('publication_id')
      .notNull()
      .references(() => publications.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    kind: text('kind', { enum: gitOperationKinds }).notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status', { enum: gitOperationStatuses }).notNull(),
    commitSha: text('commit_sha'),
    remoteName: text('remote_name'),
    /** `refs/heads/<task branch>` for pushes; the local task branch for commits. */
    ref: text('ref').notNull(),
    /** Push outcome reported by Git: `created`, `fast_forward` or `up_to_date`. */
    outcome: text('outcome'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    unique('git_operations_publication_kind_attempt_unique').on(
      table.publicationId,
      table.kind,
      table.attempt,
    ),
    index('git_operations_publication_id_idx').on(table.publicationId),
    uniqueIndex('git_operations_one_running_per_publication_idx')
      .on(table.publicationId)
      .where(sql`status = 'running'`),
    check('git_operations_kind_check', sql`${table.kind} IN (${sqlList(gitOperationKinds)})`),
    check(
      'git_operations_status_check',
      sql`${table.status} IN (${sqlList(gitOperationStatuses)})`,
    ),
    check('git_operations_attempt_check', sql`${table.attempt} >= 1`),
  ],
);

export const schema = {
  projects,
  tasks,
  securitySettings,
  workspaces,
  taskRuns,
  runEvents,
  workerCommands,
  workerLeases,
  reviews,
  publications,
  gitOperations,
};
