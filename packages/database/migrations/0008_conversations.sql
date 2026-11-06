CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`request_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "conversation_messages_role_check" CHECK("conversation_messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "conversation_messages_kind_check" CHECK("conversation_messages"."kind" IN ('note', 'chat')),
	CONSTRAINT "conversation_messages_sequence_check" CHECK("conversation_messages"."sequence" >= 1),
	CONSTRAINT "conversation_messages_note_check" CHECK("conversation_messages"."kind" <> 'note' OR ("conversation_messages"."role" = 'user' AND "conversation_messages"."request_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_request_id_unique` ON `conversation_messages` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_sequence_unique` ON `conversation_messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`agent_runtime` text NOT NULL,
	`model_id` text,
	`language_mode` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "conversations_agent_runtime_check" CHECK("conversations"."agent_runtime" IN ('claude', 'codex')),
	CONSTRAINT "conversations_language_mode_check" CHECK("conversations"."language_mode" IN ('pl_technical_en', 'pl', 'en')),
	CONSTRAINT "conversations_revision_check" CHECK("conversations"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `conversations_project_id_updated_at_idx` ON `conversations` (`project_id`,`updated_at`);