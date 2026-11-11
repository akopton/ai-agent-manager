ALTER TABLE `conversation_messages` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `deleted_at` integer;