CREATE TABLE `integration_slack_deliveries` (
	`operation_id` text NOT NULL,
	`event_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`user_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`operation_id`, `event_key`),
	FOREIGN KEY (`operation_id`) REFERENCES `integration_setup_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_integration_slack_pending_thread` ON `integration_slack_deliveries` (`operation_id`,`channel_id`,`thread_ts`) WHERE response_json IS NULL;--> statement-breakpoint
CREATE TABLE `integration_slack_threads` (
	`operation_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`binding_ref` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`operation_id`, `channel_id`, `thread_ts`),
	FOREIGN KEY (`operation_id`) REFERENCES `integration_setup_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
