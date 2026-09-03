CREATE TABLE `conversation_projection_message_facts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_message_facts_conversation` ON `conversation_projection_message_facts` (`conversation_id`,`created_at`,`message_id`);--> statement-breakpoint
CREATE TABLE `conversation_projection_message_stats` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`latest_message_id` text,
	`latest_message_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
