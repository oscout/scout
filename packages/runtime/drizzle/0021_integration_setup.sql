CREATE TABLE `integration_setup_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_realm_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`workspace_key` text NOT NULL,
	`app_id` text,
	`revision` integer NOT NULL,
	`record_json` text NOT NULL,
	CONSTRAINT "integration_setup_revision_check" CHECK("integration_setup_operations"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_setup_app` ON `integration_setup_operations` (`owner_realm_id`,`workspace_key`,`app_id`) WHERE app_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `integration_setup_operations_owner_realm_id_scope_key_workspace_key_unique` ON `integration_setup_operations` (`owner_realm_id`,`scope_key`,`workspace_key`);--> statement-breakpoint
CREATE TABLE `integration_setup_requests` (
	`owner_realm_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`operation_id` text NOT NULL,
	PRIMARY KEY(`owner_realm_id`, `request_key`),
	FOREIGN KEY (`operation_id`) REFERENCES `integration_setup_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
