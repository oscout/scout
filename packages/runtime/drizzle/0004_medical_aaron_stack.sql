CREATE TABLE `mission_log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`node_id` text,
	`at` integer NOT NULL,
	`seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`intent` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint` text,
	`blockers_json` text,
	`refs_json` text,
	`note` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mission_log_entries_mission_seq` ON `mission_log_entries` (`mission_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_mission_log_entries_mission_at` ON `mission_log_entries` (`mission_id`,"at" desc);--> statement-breakpoint
CREATE INDEX `idx_mission_log_entries_actor_at` ON `mission_log_entries` (`actor_id`,"at" desc);--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`mission_id` text,
	`project_root` text,
	`assigned_by_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`revoked_at` integer,
	`revoked_by_id` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_role_assignments_agent_active` ON `role_assignments` (`agent_id`,`active`);--> statement-breakpoint
CREATE INDEX `idx_role_assignments_mission_role_active` ON `role_assignments` (`mission_id`,`role_id`,`active`);--> statement-breakpoint
CREATE INDEX `idx_role_assignments_role_active` ON `role_assignments` (`role_id`,`active`);