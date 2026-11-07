CREATE TABLE `conversation_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`disclosure_version` text,
	`accepted_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "conversation_settings_singleton_check" CHECK("conversation_settings"."id" = 1),
	CONSTRAINT "conversation_settings_enabled_check" CHECK("conversation_settings"."enabled" IN (0, 1)),
	CONSTRAINT "conversation_settings_acceptance_check" CHECK("conversation_settings"."enabled" = 0 OR ("conversation_settings"."disclosure_version" IS NOT NULL AND "conversation_settings"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `conversation_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text,
	`retry_of_turn_id` text,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`agent_runtime` text NOT NULL,
	`requested_model_id` text,
	`effective_model_id` text,
	`language_mode` text NOT NULL,
	`security_mode` text,
	`disclosure_version` text,
	`launch_profile_id` text,
	`cli_version` text,
	`context_manifest_json` text,
	`worker_instance_id` text,
	`pid` integer,
	`stop_requested_at` integer,
	`error_code` text,
	`error_message` text,
	`exit_code` integer,
	`signal` text,
	`reply_truncated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`user_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "conversation_turns_status_check" CHECK("conversation_turns"."status" IN ('queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "conversation_turns_agent_runtime_check" CHECK("conversation_turns"."agent_runtime" IN ('claude', 'codex')),
	CONSTRAINT "conversation_turns_language_mode_check" CHECK("conversation_turns"."language_mode" IN ('pl_technical_en', 'pl', 'en')),
	CONSTRAINT "conversation_turns_reply_check" CHECK("conversation_turns"."assistant_message_id" IS NULL OR "conversation_turns"."status" = 'completed')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turns_assistant_message_id_unique` ON `conversation_turns` (`assistant_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turns_request_id_unique` ON `conversation_turns` (`request_id`);--> statement-breakpoint
CREATE INDEX `conversation_turns_conversation_created_idx` ON `conversation_turns` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_turns_status_created_idx` ON `conversation_turns` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turns_one_active_per_conversation_idx` ON `conversation_turns` (`conversation_id`) WHERE status IN ('queued', 'running', 'stopping');