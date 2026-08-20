CREATE TABLE `route_alias_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_alias` text NOT NULL,
	`display_alias` text,
	`owner_realm_id` text NOT NULL,
	`scope_project_key` text NOT NULL,
	`scope_project_root` text,
	`scope_node_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_agent_id` text,
	`target_session_id` text,
	`target_endpoint_id` text,
	`target_node_id` text NOT NULL,
	`target_harness` text,
	`target_snapshot_json` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`created_by_actor_id` text NOT NULL,
	`updated_by_actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`metadata_json` text,
	CONSTRAINT "route_alias_bindings_target_kind_check" CHECK("route_alias_bindings"."target_kind" IN ('agent', 'session')),
	CONSTRAINT "route_alias_bindings_state_check" CHECK("route_alias_bindings"."state" IN ('active', 'unset', 'expired')),
	CONSTRAINT "route_alias_bindings_revision_check" CHECK("route_alias_bindings"."revision" >= 1),
	CONSTRAINT "route_alias_bindings_target_shape_check" CHECK((
    ("route_alias_bindings"."target_kind" = 'agent' AND "route_alias_bindings"."target_agent_id" IS NOT NULL AND "route_alias_bindings"."target_session_id" IS NULL AND "route_alias_bindings"."target_endpoint_id" IS NULL AND "route_alias_bindings"."target_harness" IS NULL)
    OR
    ("route_alias_bindings"."target_kind" = 'session' AND "route_alias_bindings"."target_agent_id" IS NOT NULL AND "route_alias_bindings"."target_session_id" IS NOT NULL AND "route_alias_bindings"."target_endpoint_id" IS NOT NULL AND "route_alias_bindings"."target_harness" IS NOT NULL)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_route_alias_bindings_active_scope` ON `route_alias_bindings` (`owner_realm_id`,`scope_project_key`,`scope_node_id`,`normalized_alias`) WHERE state = 'active';--> statement-breakpoint
CREATE INDEX `idx_route_alias_bindings_target_agent` ON `route_alias_bindings` (`target_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_route_alias_bindings_target_session` ON `route_alias_bindings` (`target_session_id`);--> statement-breakpoint
CREATE INDEX `idx_route_alias_bindings_scope_updated` ON `route_alias_bindings` (`owner_realm_id`,`scope_project_key`,`scope_node_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_route_alias_bindings_expires` ON `route_alias_bindings` (`expires_at`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `route_alias_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL,
	`old_target_json` text,
	`new_target_json` text,
	`old_target_snapshot_json` text,
	`new_target_snapshot_json` text,
	`actor_id` text NOT NULL,
	`authority_node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`reason` text,
	`request_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_route_alias_revisions_binding_revision` ON `route_alias_revisions` (`binding_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_route_alias_revisions_binding_created` ON `route_alias_revisions` (`binding_id`,"created_at" desc);