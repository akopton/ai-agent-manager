ALTER TABLE `task_proposal_generations` ADD `source_message_id` text REFERENCES conversation_messages(id);--> statement-breakpoint
ALTER TABLE `task_proposal_generations` ADD `source_content` text;--> statement-breakpoint
CREATE INDEX `task_proposal_generations_source_message_idx` ON `task_proposal_generations` (`source_message_id`);