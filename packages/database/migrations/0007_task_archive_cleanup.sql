CREATE TABLE `workspace_cleanups` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`basis` text NOT NULL,
	`task_status` text NOT NULL,
	`expected_commit` text NOT NULL,
	`branch_commit` text,
	`error_code` text,
	`error_message` text,
	`worker_instance_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "workspace_cleanups_status_check" CHECK("workspace_cleanups"."status" IN ('requested', 'removing', 'removed', 'failed')),
	CONSTRAINT "workspace_cleanups_basis_check" CHECK("workspace_cleanups"."basis" IN ('published', 'discarded_unchanged')),
	CONSTRAINT "workspace_cleanups_task_status_check" CHECK("workspace_cleanups"."task_status" IN ('done', 'discarded')),
	CONSTRAINT "workspace_cleanups_removed_check" CHECK(("workspace_cleanups"."status" = 'removed') = ("workspace_cleanups"."removed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_cleanups_request_id_unique` ON `workspace_cleanups` (`request_id`);--> statement-breakpoint
CREATE INDEX `workspace_cleanups_task_id_idx` ON `workspace_cleanups` (`task_id`);--> statement-breakpoint
CREATE INDEX `workspace_cleanups_status_idx` ON `workspace_cleanups` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_cleanups_one_per_workspace_idx` ON `workspace_cleanups` (`workspace_id`) WHERE status IN ('requested', 'removing', 'removed');--> statement-breakpoint
ALTER TABLE `tasks` ADD `archived_at` integer;