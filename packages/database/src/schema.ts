import {
  activePublicationStatuses,
  activeTaskRunStatuses,
  agentRuntimes,
  conversationContextModes,
  conversationLanguageModes,
  conversationMessageKinds,
  conversationMessageRoles,
  conversationTurnStages,
  conversationTurnStatuses,
  activeConversationTurnStatuses,
  executionSecurityModes,
  gitIntegrityResultStatuses,
  gitOperationKinds,
  gitOperationStatuses,
  projectExecutionTrusts,
  projectSourceAccessValues,
  publicationFailureStages,
  publicationStatuses,
  recoveryProcessChecks,
  reviewStatuses,
  taskPriorities,
  taskProposalGenerationStatuses,
  taskProposalStatuses,
  taskRecoveryKinds,
  taskRunStatuses,
  taskStatuses,
  workspaceCleanupStatuses,
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
  // C4 source sharing with AI Conversations (migration 0012). Separate from execution trust:
  // `allowed` is valid only with the common Git directory and the disclosure version the operator
  // accepted. Evaluated in `core` (`evaluateProjectSourceAccess`).
  conversationSourceAccess: text('conversation_source_access', { enum: projectSourceAccessValues })
    .notNull()
    .default('none'),
  conversationSourceCommonDir: text('conversation_source_common_dir'),
  conversationSourceDisclosureVersion: text('conversation_source_disclosure_version'),
  conversationSourceAllowedAt: integer('conversation_source_allowed_at'),
  conversationSourceIdentity: text('conversation_source_identity'),
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
    // TM-02 (migration 0007): organizational visibility only, never a status. `NULL` = active.
    archivedAt: integer('archived_at'),
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

/**
 * Retry and Resume decisions (TM-01). Each row records the operator's request to continue after
 * one specific finished attempt (`source_run_id`, at most one recovery per attempt), the retained
 * workspace it continues in (`NULL` when the attempt ended before a worktree existed), the review
 * whose feedback is still unaddressed (`NULL` when none), and how a still-running prior process was
 * ruled out. `follow_up_run_id` is set when the worker claims the attempt that continues from it;
 * at most one recovery per task waits for its attempt. Rows are never deleted or overwritten.
 */
export const taskRecoveries = sqliteTable(
  'task_recoveries',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    kind: text('kind', { enum: taskRecoveryKinds }).notNull(),
    sourceRunId: text('source_run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    /** The task status the recovery left (Failed, Stopped or Interrupted). */
    sourceStatus: text('source_status', { enum: taskStatuses }).notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    reviewId: text('review_id').references(() => reviews.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    processCheck: text('process_check', { enum: recoveryProcessChecks }).notNull(),
    followUpRunId: text('follow_up_run_id').references(() => taskRuns.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('task_recoveries_source_run_unique').on(table.sourceRunId),
    index('task_recoveries_task_id_idx').on(table.taskId),
    uniqueIndex('task_recoveries_follow_up_run_unique')
      .on(table.followUpRunId)
      .where(sql`follow_up_run_id IS NOT NULL`),
    uniqueIndex('task_recoveries_one_pending_per_task_idx')
      .on(table.taskId)
      .where(sql`follow_up_run_id IS NULL`),
    check('task_recoveries_kind_check', sql`${table.kind} IN (${sqlList(taskRecoveryKinds)})`),
    check(
      'task_recoveries_source_status_check',
      sql`${table.sourceStatus} IN ('failed', 'stopped', 'interrupted')`,
    ),
    check(
      'task_recoveries_process_check_check',
      sql`${table.processCheck} IN (${sqlList(recoveryProcessChecks)})`,
    ),
  ],
);

const activeCleanupCondition = sql.raw(`status IN ('requested', 'removing', 'removed')`);

/**
 * Removal of a task's managed local worktree (TM-02, migration `0007_task_archive_cleanup`). One
 * row per operator request: the workspace and the commit the worktree had to be at, why the task no
 * longer needs it (`basis`), and the outcome the worker recorded. The `workspaces` row is kept and
 * never deleted (its `status` CHECK only allows `retained`, so the removal is recorded here,
 * additively). At most one requested, running or completed removal per workspace (partial unique
 * index); `failed` rows stay as history. `request_id` deduplicates repeated submissions.
 */
export const workspaceCleanups = sqliteTable(
  'workspace_cleanups',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().unique(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    status: text('status', { enum: workspaceCleanupStatuses }).notNull(),
    basis: text('basis', { enum: ['published', 'discarded_unchanged'] }).notNull(),
    /** The task status when the removal was requested. */
    taskStatus: text('task_status', { enum: taskStatuses }).notNull(),
    expectedCommit: text('expected_commit').notNull(),
    /** Where the preserved task branch pointed after the removal. */
    branchCommit: text('branch_commit'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    workerInstanceId: text('worker_instance_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    removedAt: integer('removed_at'),
  },
  (table) => [
    index('workspace_cleanups_task_id_idx').on(table.taskId),
    index('workspace_cleanups_status_idx').on(table.status),
    uniqueIndex('workspace_cleanups_one_per_workspace_idx')
      .on(table.workspaceId)
      .where(activeCleanupCondition),
    check(
      'workspace_cleanups_status_check',
      sql`${table.status} IN (${sqlList(workspaceCleanupStatuses)})`,
    ),
    check(
      'workspace_cleanups_basis_check',
      sql`${table.basis} IN ('published', 'discarded_unchanged')`,
    ),
    check(
      'workspace_cleanups_task_status_check',
      sql`${table.taskStatus} IN ('done', 'discarded')`,
    ),
    check(
      'workspace_cleanups_removed_check',
      sql`(${table.status} = 'removed') = (${table.removedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * AI Conversations (C1, migration `0008_conversations`). A conversation belongs to exactly one
 * project (`RESTRICT`: a project with conversations cannot be disconnected, and conversations are
 * never deleted with it). `model_id = NULL` means `Default`. `revision` is the settings revision
 * used to reject stale updates. `updated_at` is the last change to the settings or the history.
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    title: text('title').notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    modelId: text('model_id'),
    languageMode: text('language_mode', { enum: conversationLanguageModes }).notNull(),
    /** C4 (migration 0012): `general` for every conversation created before C4. */
    contextMode: text('context_mode', { enum: conversationContextModes })
      .notNull()
      .default('general'),
    revision: integer('revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessageAt: integer('last_message_at'),
  },
  (table) => [
    index('conversations_project_id_updated_at_idx').on(table.projectId, table.updatedAt),
    check(
      'conversations_agent_runtime_check',
      sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`,
    ),
    check(
      'conversations_language_mode_check',
      sql`${table.languageMode} IN (${sqlList(conversationLanguageModes)})`,
    ),
    check('conversations_revision_check', sql`${table.revision} >= 1`),
  ],
);

/**
 * The ordered history of a conversation (C1). `sequence` is allocated per conversation (1, 2, 3…)
 * inside the inserting transaction and is unique, so the order is deterministic. Roles and kinds
 * already include the values C2 needs (`assistant`, `chat`) so it does not have to rebuild the
 * table; C1 writes only `user` notes, and a note must be a `user` message with a `request_id`.
 * `request_id` deduplicates repeated submissions. Messages are never edited or deleted in C1.
 */
export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    sequence: integer('sequence').notNull(),
    role: text('role', { enum: conversationMessageRoles }).notNull(),
    kind: text('kind', { enum: conversationMessageKinds }).notNull(),
    content: text('content').notNull(),
    requestId: text('request_id').unique(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('conversation_messages_sequence_unique').on(table.conversationId, table.sequence),
    check(
      'conversation_messages_role_check',
      sql`${table.role} IN (${sqlList(conversationMessageRoles)})`,
    ),
    check(
      'conversation_messages_kind_check',
      sql`${table.kind} IN (${sqlList(conversationMessageKinds)})`,
    ),
    check('conversation_messages_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'conversation_messages_note_check',
      sql`${table.kind} <> 'note' OR (${table.role} = 'user' AND ${table.requestId} IS NOT NULL)`,
    ),
  ],
);

/**
 * AI Conversations consent (C2, single row `id = 1`). Separate from `security_settings`: accepting
 * the Trusted Local execution disclosure never enables conversations, and this acceptance never
 * enables task execution. Disabling clears the acceptance.
 */
export const conversationSettings = sqliteTable(
  'conversation_settings',
  {
    id: integer('id').primaryKey(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    disclosureVersion: text('disclosure_version'),
    acceptedAt: integer('accepted_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('conversation_settings_singleton_check', sql`${table.id} = 1`),
    check('conversation_settings_enabled_check', sql`${table.enabled} IN (0, 1)`),
    check(
      'conversation_settings_acceptance_check',
      sql`${table.enabled} = 0 OR (${table.disclosureVersion} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * CLI-backed conversation turns (C2). One row per request for an AI reply to one user `chat`
 * message. The runtime, model and language are snapshotted when the turn is queued. At most one
 * active (`queued`, `running`, `stopping`) turn per conversation. `assistant_message_id` is set only
 * by a completed turn; failed, cancelled and interrupted turns never point to a reply. A retry is
 * a new row for the same user message (`retry_of_turn_id`). Rows are never deleted.
 */
export const conversationTurns = sqliteTable(
  'conversation_turns',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userMessageId: text('user_message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    assistantMessageId: text('assistant_message_id')
      .unique()
      .references(() => conversationMessages.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    retryOfTurnId: text('retry_of_turn_id'),
    /** Client request ID of the send or retry; deduplicates repeated submissions. */
    requestId: text('request_id').notNull().unique(),
    status: text('status', { enum: conversationTurnStatuses }).notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    requestedModelId: text('requested_model_id'),
    /** Only when the CLI reported it (Claude Code `init` event); never inferred. */
    effectiveModelId: text('effective_model_id'),
    languageMode: text('language_mode', { enum: conversationLanguageModes }).notNull(),
    securityMode: text('security_mode', { enum: executionSecurityModes }),
    disclosureVersion: text('disclosure_version'),
    launchProfileId: text('launch_profile_id'),
    cliVersion: text('cli_version'),
    /** What was sent (history sequences, budget, language); never the prompt itself. */
    contextManifestJson: text('context_manifest_json'),
    workerInstanceId: text('worker_instance_id'),
    pid: integer('pid'),
    stopRequestedAt: integer('stop_requested_at'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    replyTruncated: integer('reply_truncated', { mode: 'boolean' }).notNull().default(false),
    /**
     * C4 (migration 0012): the context mode snapshotted when the turn was queued (`general` for
     * every earlier turn), the progress of a project-aware turn, and its retrieval record (paths,
     * line ranges, commit and limits; never file content).
     */
    contextMode: text('context_mode', { enum: conversationContextModes })
      .notNull()
      .default('general'),
    contextStage: text('context_stage', { enum: conversationTurnStages }),
    repositoryContextJson: text('repository_context_json'),
    createdAt: integer('created_at').notNull(),
    claimedAt: integer('claimed_at'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('conversation_turns_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('conversation_turns_status_created_idx').on(table.status, table.createdAt),
    uniqueIndex('conversation_turns_one_active_per_conversation_idx')
      .on(table.conversationId)
      .where(sql`status IN (${sqlList(activeConversationTurnStatuses)})`),
    check(
      'conversation_turns_status_check',
      sql`${table.status} IN (${sqlList(conversationTurnStatuses)})`,
    ),
    check(
      'conversation_turns_agent_runtime_check',
      sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`,
    ),
    check(
      'conversation_turns_language_mode_check',
      sql`${table.languageMode} IN (${sqlList(conversationLanguageModes)})`,
    ),
    check(
      'conversation_turns_reply_check',
      sql`${table.assistantMessageId} IS NULL OR ${table.status} = 'completed'`,
    ),
  ],
);

/**
 * C3 task proposal generations (migration `0010_task_proposals`). One row per explicit operator
 * request for task proposals from a conversation. Runs through the same conversation gate and
 * launch boundary as a C2 turn and shares its lifecycle, but appends **no** message: the history
 * is never changed. The runtime, model, language and the last message sequence it is based on
 * are snapshotted when it is queued. At most one active generation per conversation; a chat turn
 * and a generation are never active at the same time (enforced by the commands). Rows are never
 * deleted.
 */
export const taskProposalGenerations = sqliteTable(
  'task_proposal_generations',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    retryOfGenerationId: text('retry_of_generation_id'),
    /** Client request ID of the request or retry; deduplicates repeated submissions. */
    requestId: text('request_id').notNull().unique(),
    status: text('status', { enum: taskProposalGenerationStatuses }).notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    requestedModelId: text('requested_model_id'),
    effectiveModelId: text('effective_model_id'),
    languageMode: text('language_mode', { enum: conversationLanguageModes }).notNull(),
    /** The operator's optional focus; empty when none was given. */
    instructions: text('instructions').notNull().default(''),
    /**
     * C3.1 (migration `0011`): the completed AI reply the proposals are generated from, and a
     * snapshot of its text taken when the request was made (retries reuse it). Both `NULL` for C3
     * generations, which used the answered conversation history instead.
     */
    sourceMessageId: text('source_message_id').references(() => conversationMessages.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    sourceContent: text('source_content'),
    /** The highest message sequence when requested; later messages are not sent. */
    basedOnSequence: integer('based_on_sequence').notNull(),
    securityMode: text('security_mode', { enum: executionSecurityModes }),
    disclosureVersion: text('disclosure_version'),
    launchProfileId: text('launch_profile_id'),
    cliVersion: text('cli_version'),
    contextManifestJson: text('context_manifest_json'),
    workerInstanceId: text('worker_instance_id'),
    pid: integer('pid'),
    stopRequestedAt: integer('stop_requested_at'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    /** Proposals stored by this generation (only when completed). */
    proposalCount: integer('proposal_count').notNull().default(0),
    /** Items of the reply that failed validation or exceeded the limit; never stored. */
    skippedCount: integer('skipped_count').notNull().default(0),
    /** The AI's note from the proposal document, if any. */
    outputNote: text('output_note'),
    createdAt: integer('created_at').notNull(),
    claimedAt: integer('claimed_at'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('task_proposal_generations_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    index('task_proposal_generations_status_created_idx').on(table.status, table.createdAt),
    index('task_proposal_generations_source_message_idx').on(table.sourceMessageId),
    uniqueIndex('task_proposal_generations_one_active_per_conversation_idx')
      .on(table.conversationId)
      .where(sql`status IN (${sqlList(activeConversationTurnStatuses)})`),
    check(
      'task_proposal_generations_status_check',
      sql`${table.status} IN (${sqlList(taskProposalGenerationStatuses)})`,
    ),
    check(
      'task_proposal_generations_agent_runtime_check',
      sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`,
    ),
    check(
      'task_proposal_generations_language_mode_check',
      sql`${table.languageMode} IN (${sqlList(conversationLanguageModes)})`,
    ),
    check(
      'task_proposal_generations_counts_check',
      sql`${table.proposalCount} >= 0 AND ${table.skippedCount} >= 0 AND (${table.status} = 'completed' OR ${table.proposalCount} = 0)`,
    ),
    check('task_proposal_generations_sequence_check', sql`${table.basedOnSequence} >= 0`),
  ],
);

/**
 * C3 task proposals. Stored only by a completed generation, as `draft`. The editable task fields
 * (`title` … `base_branch`) hold the operator's current values; `suggested_*`, `rationale` and
 * `dependencies` keep what the AI suggested and never change. `project_id` is copied from the
 * conversation and never changes, so a proposal cannot move to another project. An approved
 * proposal points to the one task its approval created (`task_id`, unique); tasks themselves are
 * unchanged and carry no conversation metadata. `revision` rejects stale edits and approvals.
 */
export const taskProposals = sqliteTable(
  'task_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    generationId: text('generation_id')
      .notNull()
      .references(() => taskProposalGenerations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    /** Order within the generation, as the AI listed them (1, 2, 3…). */
    position: integer('position').notNull(),
    status: text('status', { enum: taskProposalStatuses }).notNull(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    agentRuntime: text('agent_runtime', { enum: agentRuntimes }).notNull(),
    modelId: text('model_id'),
    priority: text('priority', { enum: taskPriorities }).notNull(),
    baseBranch: text('base_branch'),
    suggestedTitle: text('suggested_title').notNull(),
    suggestedPrompt: text('suggested_prompt').notNull(),
    suggestedPriority: text('suggested_priority', { enum: taskPriorities }).notNull(),
    rationale: text('rationale').notNull().default(''),
    dependencies: text('dependencies').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    taskId: text('task_id')
      .unique()
      .references(() => tasks.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    approvedAt: integer('approved_at'),
    rejectedAt: integer('rejected_at'),
  },
  (table) => [
    unique('task_proposals_generation_position_unique').on(table.generationId, table.position),
    index('task_proposals_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('task_proposals_project_id_idx').on(table.projectId),
    check(
      'task_proposals_status_check',
      sql`${table.status} IN (${sqlList(taskProposalStatuses)})`,
    ),
    check(
      'task_proposals_agent_runtime_check',
      sql`${table.agentRuntime} IN (${sqlList(agentRuntimes)})`,
    ),
    check(
      'task_proposals_priority_check',
      sql`${table.priority} IN (${sqlList(taskPriorities)}) AND ${table.suggestedPriority} IN (${sqlList(taskPriorities)})`,
    ),
    check('task_proposals_revision_check', sql`${table.revision} >= 1`),
    check('task_proposals_position_check', sql`${table.position} >= 1`),
    check(
      'task_proposals_approved_check',
      sql`(${table.status} = 'approved') = (${table.taskId} IS NOT NULL) AND (${table.status} = 'approved') = (${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      'task_proposals_rejected_check',
      sql`(${table.status} = 'rejected') = (${table.rejectedAt} IS NOT NULL)`,
    ),
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
  taskRecoveries,
  workspaceCleanups,
  conversations,
  conversationMessages,
  conversationSettings,
  conversationTurns,
  taskProposalGenerations,
  taskProposals,
};
