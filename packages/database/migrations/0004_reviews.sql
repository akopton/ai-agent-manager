CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`feedback` text NOT NULL,
	`inventory_revision` text NOT NULL,
	`follow_up_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`follow_up_run_id`) REFERENCES `task_runs`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "reviews_status_check" CHECK("reviews"."status" IN ('changes_requested')),
	CONSTRAINT "reviews_feedback_check" CHECK(length(trim("reviews"."feedback")) > 0)
);
--> statement-breakpoint
CREATE INDEX `reviews_task_id_idx` ON `reviews` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_follow_up_run_unique` ON `reviews` (`follow_up_run_id`) WHERE follow_up_run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_one_pending_change_request_per_task_idx` ON `reviews` (`task_id`) WHERE status = 'changes_requested' AND follow_up_run_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_run_unique` ON `reviews` (`run_id`);