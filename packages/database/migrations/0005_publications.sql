CREATE TABLE `git_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`commit_sha` text,
	`remote_name` text,
	`ref` text NOT NULL,
	`outcome` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "git_operations_kind_check" CHECK("git_operations"."kind" IN ('commit', 'push')),
	CONSTRAINT "git_operations_status_check" CHECK("git_operations"."status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "git_operations_attempt_check" CHECK("git_operations"."attempt" >= 1)
);
--> statement-breakpoint
CREATE INDEX `git_operations_publication_id_idx` ON `git_operations` (`publication_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `git_operations_one_running_per_publication_idx` ON `git_operations` (`publication_id`) WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX `git_operations_publication_kind_attempt_unique` ON `git_operations` (`publication_id`,`kind`,`attempt`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`failure_stage` text,
	`error_code` text,
	`error_message` text,
	`inventory_revision` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`file_count` integer NOT NULL,
	`base_commit` text NOT NULL,
	`branch` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_url` text NOT NULL,
	`remote_url_digest` text NOT NULL,
	`commit_message` text NOT NULL,
	`commit_sha` text,
	`tree_sha` text,
	`worker_instance_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`committed_at` integer,
	`pushed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "publications_status_check" CHECK("publications"."status" IN ('approved', 'committing', 'committed', 'push_requested', 'pushing', 'pushed', 'failed')),
	CONSTRAINT "publications_failure_stage_check" CHECK(("publications"."status" = 'failed') = ("publications"."failure_stage" IS NOT NULL) AND ("publications"."failure_stage" IS NULL OR "publications"."failure_stage" IN ('validation', 'commit', 'push'))),
	CONSTRAINT "publications_commit_check" CHECK("publications"."status" NOT IN ('committed', 'push_requested', 'pushing', 'pushed') OR "publications"."commit_sha" IS NOT NULL),
	CONSTRAINT "publications_file_count_check" CHECK("publications"."file_count" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_request_id_unique` ON `publications` (`request_id`);--> statement-breakpoint
CREATE INDEX `publications_task_id_idx` ON `publications` (`task_id`);--> statement-breakpoint
CREATE INDEX `publications_status_idx` ON `publications` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_one_active_per_task_idx` ON `publications` (`task_id`) WHERE status IN ('approved', 'committing', 'committed', 'push_requested', 'pushing');