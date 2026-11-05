CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_path` text NOT NULL,
	`git_common_dir` text NOT NULL,
	`remote_name` text,
	`default_base_branch` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_local_path_unique` ON `projects` (`local_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_git_common_dir_unique` ON `projects` (`git_common_dir`);