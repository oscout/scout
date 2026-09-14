CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`identity_keys_json` text NOT NULL,
	`is_self` integer DEFAULT 0 NOT NULL,
	`scout_node_id` text,
	`mesh_id` text,
	`tailnet_id` text,
	`tailnet_name` text,
	`host_names_json` text,
	`addresses_json` text,
	`mac_addresses_json` text,
	`capabilities_json` text,
	`routes_json` text,
	`evidence_json` text,
	`pinned` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`metadata_json` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_machines_last_seen_at` ON `machines` ("last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_machines_scout_node_id` ON `machines` (`scout_node_id`);
