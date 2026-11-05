CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_sequence_unique` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `security_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`trusted_local_enabled` integer DEFAULT false NOT NULL,
	`trusted_local_disclosure_version` text,
	`trusted_local_accepted_at` integer,
	`trusted_local_accepted_risks_json` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "security_settings_singleton_check" CHECK("security_settings"."id" = 1),
	CONSTRAINT "security_settings_enabled_check" CHECK("security_settings"."trusted_local_enabled" IN (0, 1)),
	CONSTRAINT "security_settings_acceptance_check" CHECK("security_settings"."trusted_local_enabled" = 0 OR ("security_settings"."trusted_local_disclosure_version" IS NOT NULL AND "security_settings"."trusted_local_accepted_at" IS NOT NULL AND "security_settings"."trusted_local_accepted_risks_json" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`agent_runtime` text NOT NULL,
	`requested_model_id` text,
	`effective_model_id` text,
	`status` text NOT NULL,
	`workspace_id` text,
	`security_mode` text NOT NULL,
	`disclosure_version` text,
	`launch_profile_id` text,
	`cli_version` text,
	`authorization_id` text,
	`control_assessment_json` text,
	`accepted_risks_json` text,
	`safeguards_json` text,
	`process_containment` text,
	`timeout_ms` integer NOT NULL,
	`worker_instance_id` text NOT NULL,
	`pid` integer,
	`session_id` text,
	`exit_code` integer,
	`signal` text,
	`lingering_processes` text,
	`error_code` text,
	`error_message` text,
	`summary` text,
	`stop_requested_at` integer,
	`git_integrity_status` text DEFAULT 'not_run' NOT NULL,
	`git_integrity_baseline_json` text,
	`git_integrity_result_json` text,
	`git_integrity_checked_at` integer,
	`events_dropped` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "task_runs_agent_runtime_check" CHECK("task_runs"."agent_runtime" IN ('claude', 'codex')),
	CONSTRAINT "task_runs_status_check" CHECK("task_runs"."status" IN ('pending', 'starting', 'running', 'stopping', 'completed', 'stopped', 'failed', 'interrupted')),
	CONSTRAINT "task_runs_security_mode_check" CHECK("task_runs"."security_mode" IN ('strict_isolated', 'trusted_local')),
	CONSTRAINT "task_runs_git_integrity_status_check" CHECK("task_runs"."git_integrity_status" IN ('not_run', 'clean', 'violation', 'inconclusive')),
	CONSTRAINT "task_runs_attempt_check" CHECK("task_runs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE INDEX `task_runs_status_idx` ON `task_runs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_one_active_per_task_idx` ON `task_runs` (`task_id`) WHERE status IN ('pending', 'starting', 'running', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_one_active_per_runtime_idx` ON `task_runs` (`agent_runtime`) WHERE status IN ('pending', 'starting', 'running', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_task_attempt_unique` ON `task_runs` (`task_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `worker_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`result_code` text,
	`result_message` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "worker_commands_kind_check" CHECK("worker_commands"."kind" IN ('start_task')),
	CONSTRAINT "worker_commands_status_check" CHECK("worker_commands"."status" IN ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `worker_commands_status_created_idx` ON `worker_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `worker_commands_one_pending_per_task_idx` ON `worker_commands` (`task_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `worker_leases` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`pid` integer NOT NULL,
	`acquired_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "worker_leases_singleton_check" CHECK("worker_leases"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`generation` integer NOT NULL,
	`repository_root` text NOT NULL,
	`git_common_dir` text NOT NULL,
	`worktree_root` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`status` text DEFAULT 'retained' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "workspaces_status_check" CHECK("workspaces"."status" IN ('retained'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_task_generation_unique` ON `workspaces` (`task_id`,`generation`);--> statement-breakpoint
ALTER TABLE `projects` ADD `execution_trust` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `execution_trusted_common_dir` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `execution_trusted_at` integer;