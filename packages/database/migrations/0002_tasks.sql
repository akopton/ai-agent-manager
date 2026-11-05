CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`agent_runtime` text NOT NULL,
	`model_id` text,
	`base_branch` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`queued_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "tasks_agent_runtime_check" CHECK("tasks"."agent_runtime" IN ('claude', 'codex')),
	CONSTRAINT "tasks_priority_check" CHECK("tasks"."priority" IN ('critical', 'high', 'normal', 'low')),
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" IN ('backlog', 'queued', 'in_progress', 'review', 'done', 'stopped', 'interrupted', 'failed', 'discarded')),
	CONSTRAINT "tasks_urgent_check" CHECK("tasks"."urgent" IN (0, 1)),
	CONSTRAINT "tasks_queued_at_check" CHECK("tasks"."status" <> 'queued' OR "tasks"."queued_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `tasks_status_queued_at_idx` ON `tasks` (`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `tasks_project_id_status_idx` ON `tasks` (`project_id`,`status`);