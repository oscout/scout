CREATE TABLE `context_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`memory_kind` text,
	`state` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`summary` text,
	`projection_mode` text NOT NULL,
	`mutability` text NOT NULL,
	`created_by_id` text NOT NULL,
	`owner_id` text,
	`source_refs_json` text NOT NULL,
	`confidence` real,
	`token_budget` integer,
	`freshness_json` text,
	`version` integer NOT NULL,
	`supersedes_id` text,
	`content_hash` text NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_context_blocks_scope_state_updated_at` ON `context_blocks` (`scope_kind`,`scope_id`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_context_blocks_kind_state_updated_at` ON `context_blocks` (`kind`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `context_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`target_json` text NOT NULL,
	`sections_json` text NOT NULL,
	`context_block_ids_json` text NOT NULL,
	`source_refs_json` text NOT NULL,
	`budget_json` text NOT NULL,
	`limitations_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by_id` text NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_context_packs_created_at` ON `context_packs` ("created_at" desc);