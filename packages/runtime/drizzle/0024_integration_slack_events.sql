CREATE TABLE `integration_slack_events` (
	`operation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`envelope_json` text NOT NULL,
	`delivery_key` text NOT NULL,
	`progress_json` text,
	`result_completed_at` integer,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`operation_id`, `event_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `integration_setup_operations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "integration_slack_event_state_check" CHECK("integration_slack_events"."state" IN ('pending', 'processed'))
);
--> statement-breakpoint
CREATE INDEX `idx_integration_slack_pending_events` ON `integration_slack_events` (`operation_id`,`state`,`received_at`);