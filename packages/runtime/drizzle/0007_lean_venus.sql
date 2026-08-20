CREATE TABLE `peer_nonces` (
	`peer_key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`peer_key_id`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `idx_peer_nonces_seen_at` ON `peer_nonces` (`seen_at`);--> statement-breakpoint
CREATE TABLE `trusted_peers` (
	`key_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`node_id` text,
	`label` text NOT NULL,
	`tier` text NOT NULL,
	`granted_via` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_seen_at` integer,
	`metadata_json` text,
	CONSTRAINT "trusted_peers_tier_check" CHECK("trusted_peers"."tier" IN ('observe', 'control'))
);
--> statement-breakpoint
CREATE INDEX `idx_trusted_peers_node_id` ON `trusted_peers` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_trusted_peers_label` ON `trusted_peers` (`label`);