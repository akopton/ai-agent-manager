ALTER TABLE `conversation_turns` ADD `context_mode` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `context_stage` text;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `repository_context_json` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `context_mode` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `conversation_source_access` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `conversation_source_common_dir` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `conversation_source_disclosure_version` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `conversation_source_allowed_at` integer;