CREATE TABLE `broker_journal_projection_checkpoints` (
	`projection_id` text PRIMARY KEY NOT NULL,
	`projection_version` integer NOT NULL,
	`barrier_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
