CREATE TABLE `integration_worker_leases` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `integration_setup_operations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "integration_worker_generation_check" CHECK("integration_worker_leases"."generation" >= 1),
	CONSTRAINT "integration_worker_state_check" CHECK("integration_worker_leases"."state" IN ('starting', 'connected', 'stopped'))
);
