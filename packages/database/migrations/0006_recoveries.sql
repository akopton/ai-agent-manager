CREATE TABLE `task_recoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_run_id` text NOT NULL,
	`source_status` text NOT NULL,
	`workspace_id` text,
	`review_id` text,
	`process_check` text NOT NULL,
	`follow_up_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`source_run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`follow_up_run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "task_recoveries_kind_check" CHECK("task_recoveries"."kind" IN ('retry', 'resume')),
	CONSTRAINT "task_recoveries_source_status_check" CHECK("task_recoveries"."source_status" IN ('failed', 'stopped', 'interrupted')),
	CONSTRAINT "task_recoveries_process_check_check" CHECK("task_recoveries"."process_check" IN ('not_launched', 'process_group_gone', 'operator_confirmed'))
);
--> statement-breakpoint
CREATE INDEX `task_recoveries_task_id_idx` ON `task_recoveries` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_recoveries_follow_up_run_unique` ON `task_recoveries` (`follow_up_run_id`) WHERE follow_up_run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_recoveries_one_pending_per_task_idx` ON `task_recoveries` (`task_id`) WHERE follow_up_run_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_recoveries_source_run_unique` ON `task_recoveries` (`source_run_id`);