CREATE TABLE `activity_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ts` integer NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`invocation_id` text,
	`flight_id` text,
	`record_id` text,
	`actor_id` text,
	`counterpart_id` text,
	`agent_id` text,
	`workspace_root` text,
	`session_id` text,
	`title` text,
	`summary` text,
	`payload_json` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flight_id`) REFERENCES `flights`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `collaboration_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`counterpart_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_activity_items_agent_ts` ON `activity_items` (`agent_id`,"ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_actor_ts` ON `activity_items` (`actor_id`,"ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_conversation_ts` ON `activity_items` (`conversation_id`,"ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_ts` ON `activity_items` ("ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_workspace_ts` ON `activity_items` (`workspace_root`,"ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_kind_ts` ON `activity_items` (`kind`,"ts" desc);--> statement-breakpoint
CREATE INDEX `idx_activity_items_session_ts` ON `activity_items` (`session_id`,"ts" desc);--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`handle` text,
	`labels_json` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`node_id` text NOT NULL,
	`harness` text NOT NULL,
	`transport` text NOT NULL,
	`state` text NOT NULL,
	`address` text,
	`session_id` text,
	`pane` text,
	`cwd` text,
	`project_root` text,
	`metadata_json` text,
	`updated_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_agent_endpoints_agent_updated_at` ON `agent_endpoints` (`agent_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`node_qualifier` text,
	`workspace_qualifier` text,
	`selector` text,
	`default_selector` text,
	`agent_class` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`wake_policy` text NOT NULL,
	`home_node_id` text NOT NULL,
	`authority_node_id` text NOT NULL,
	`advertise_scope` text NOT NULL,
	`owner_id` text,
	`metadata_json` text,
	FOREIGN KEY (`id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`home_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`authority_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`platform` text NOT NULL,
	`mode` text NOT NULL,
	`external_channel_id` text NOT NULL,
	`external_thread_id` text,
	`metadata_json` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `briefings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`recommendation` text,
	`prepared_at` integer NOT NULL,
	`ttl_ms` integer NOT NULL,
	`brief_json` text NOT NULL,
	`observations_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`call_json` text NOT NULL,
	`markdown` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_briefings_created_at` ON `briefings` ("created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_briefings_kind_created_at` ON `briefings` (`kind`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `budget_quota_window_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`harness` text,
	`transport` text,
	`model` text,
	`agent_id` text,
	`endpoint_id` text,
	`session_id` text,
	`user_id` text,
	`account_id` text,
	`plan_type` text,
	`label` text NOT NULL,
	`window_kind` text,
	`used_percent` real,
	`percent_remaining` real,
	`used` real,
	`limit_value` real,
	`reset_at` integer,
	`window_ms` integer,
	`captured_at` integer NOT NULL,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_budget_quota_windows_session_captured` ON `budget_quota_window_snapshots` (`session_id`,"captured_at" desc);--> statement-breakpoint
CREATE INDEX `idx_budget_quota_windows_provider_label` ON `budget_quota_window_snapshots` (`provider`,`label`,"captured_at" desc);--> statement-breakpoint
CREATE TABLE `budget_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`harness` text,
	`transport` text,
	`model` text,
	`agent_id` text,
	`endpoint_id` text,
	`session_id` text,
	`project_root` text,
	`conversation_id` text,
	`message_id` text,
	`invocation_id` text,
	`flight_id` text,
	`work_id` text,
	`occurred_at` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`reasoning_output_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`total_tokens` integer,
	`estimated_usd` real,
	`billed_usd` real,
	`currency` text,
	`dedup_key` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_budget_usage_events_scope_occurred` ON `budget_usage_events` (`scope`,"occurred_at" desc);--> statement-breakpoint
CREATE INDEX `idx_budget_usage_events_session_occurred` ON `budget_usage_events` (`session_id`,"occurred_at" desc);--> statement-breakpoint
CREATE INDEX `idx_budget_usage_events_invocation` ON `budget_usage_events` (`invocation_id`,"occurred_at" desc);--> statement-breakpoint
CREATE INDEX `idx_budget_usage_events_flight` ON `budget_usage_events` (`flight_id`,"occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_budget_usage_events_dedup` ON `budget_usage_events` (`scope`,`source`,`dedup_key`) WHERE dedup_key IS NOT NULL AND dedup_key != '';--> statement-breakpoint
CREATE TABLE `collaboration_events` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`record_kind` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`summary` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `collaboration_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_collaboration_events_record_created_at` ON `collaboration_events` (`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `collaboration_records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`acceptance_state` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`created_by_id` text NOT NULL,
	`owner_id` text,
	`next_move_owner_id` text,
	`conversation_id` text,
	`parent_id` text,
	`priority` text,
	`labels_json` text,
	`relations_json` text,
	`detail_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`next_move_owner_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `collaboration_records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_state` ON `collaboration_records` (`state`);--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_updated_at` ON `collaboration_records` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_kind_state_updated_at` ON `collaboration_records` (`kind`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_parent_kind_state_updated_at` ON `collaboration_records` (`parent_id`,`kind`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_owner_kind_state_updated_at` ON `collaboration_records` (`owner_id`,`kind`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_collaboration_records_next_move_owner_kind_state_updated_at` ON `collaboration_records` (`next_move_owner_id`,`kind`,`state`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`role` text,
	PRIMARY KEY(`conversation_id`, `actor_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_read_cursors` (
	`conversation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`reader_node_id` text,
	`last_read_message_id` text,
	`last_read_seq` integer,
	`last_read_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`metadata_json` text,
	PRIMARY KEY(`conversation_id`, `actor_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reader_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_read_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_read_cursors_conversation_updated_at` ON `conversation_read_cursors` (`conversation_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`visibility` text NOT NULL,
	`share_mode` text NOT NULL,
	`authority_node_id` text NOT NULL,
	`topic` text,
	`parent_conversation_id` text,
	`message_id` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL,
	FOREIGN KEY (`authority_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_created_at` ON `conversations` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`invocation_id` text,
	`target_id` text NOT NULL,
	`target_node_id` text,
	`target_kind` text NOT NULL,
	`transport` text NOT NULL,
	`reason` text NOT NULL,
	`policy` text NOT NULL,
	`status` text NOT NULL,
	`binding_id` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_deliveries_status_transport` ON `deliveries` (`status`,`transport`);--> statement-breakpoint
CREATE INDEX `idx_deliveries_created_at` ON `deliveries` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`external_ref` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_attempts_created_at` ON `delivery_attempts` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `durable_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`authority_cell_id` text NOT NULL,
	`state` text NOT NULL,
	`idempotency_key` text,
	`lease_owner` text,
	`lease_generation` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_durable_actions_idempotency_key` ON `durable_actions` (`authority_cell_id`,`kind`,`idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_durable_actions_authority_state_lease` ON `durable_actions` (`authority_cell_id`,`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_durable_actions_subject` ON `durable_actions` (`kind`,`subject_id`);--> statement-breakpoint
-- hand-edited: drizzle-kit 0.31 comma-splits sql`` index expressions (see
-- DURABLE_ACTIONS_DUE_AT_INDEX_SQL in drizzle-schema.ts); this is the correct
-- form of the statement it mangled. The parity test pins it against the raw schema.
CREATE INDEX `idx_durable_actions_kind_due_at_updated_at` ON `durable_actions` (`kind`,COALESCE(CAST(json_extract(metadata_json, '$.dueAt') AS REAL), CAST(json_extract(metadata_json, '$.due_at') AS REAL)),`updated_at`);--> statement-breakpoint
CREATE TABLE `durable_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`state` text NOT NULL,
	`lease_generation` integer NOT NULL,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`metadata_json` text,
	FOREIGN KEY (`action_id`) REFERENCES `durable_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_durable_attempts_action_attempt` ON `durable_attempts` (`action_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_attempts_action_id_attempt_unique` ON `durable_attempts` (`action_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `durable_checkpoints` (
	`action_id` text NOT NULL,
	`name` text NOT NULL,
	`payload_json` text,
	`owner_attempt_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`action_id`, `name`),
	FOREIGN KEY (`action_id`) REFERENCES `durable_actions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_attempt_id`) REFERENCES `durable_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `durable_signals` (
	`action_id` text NOT NULL,
	`name` text NOT NULL,
	`payload_json` text,
	`emitted_at` integer NOT NULL,
	PRIMARY KEY(`action_id`, `name`),
	FOREIGN KEY (`action_id`) REFERENCES `durable_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`node_id` text,
	`ts` integer NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_kind_ts` ON `events` (`kind`,`ts`);--> statement-breakpoint
CREATE TABLE `flights` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`output` text,
	`error` text,
	`labels_json` text,
	`metadata_json` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_flights_target_state` ON `flights` (`target_agent_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_flights_invocation_id` ON `flights` (`invocation_id`);--> statement-breakpoint
CREATE TABLE `invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`requester_node_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`target_node_id` text,
	`action` text NOT NULL,
	`task` text NOT NULL,
	`collaboration_record_id` text,
	`conversation_id` text,
	`message_id` text,
	`context_json` text,
	`execution_json` text,
	`ensure_awake` integer DEFAULT 1 NOT NULL,
	`stream` integer DEFAULT 1 NOT NULL,
	`timeout_ms` integer,
	`labels_json` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requester_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`collaboration_record_id`) REFERENCES `collaboration_records`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_invocations_target_created_at` ON `invocations` (`target_agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_invocations_requester_created_at` ON `invocations` (`requester_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`media_type` text NOT NULL,
	`file_name` text,
	`blob_key` text,
	`url` text,
	`metadata_json` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`label` text,
	PRIMARY KEY(`message_id`, `actor_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`origin_node_id` text NOT NULL,
	`class` text NOT NULL,
	`body` text NOT NULL,
	`reply_to_message_id` text,
	`thread_conversation_id` text,
	`speech_json` text,
	`audience_json` text,
	`visibility` text NOT NULL,
	`policy` text NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`origin_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_created_at` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` ("created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_messages_actor_created_at` ON `messages` (`actor_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `mobile_push_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`platform` text NOT NULL,
	`app_bundle_id` text NOT NULL,
	`apns_environment` text NOT NULL,
	`push_token` text NOT NULL,
	`authorization_status` text NOT NULL,
	`app_version` text,
	`build_number` text,
	`device_model` text,
	`system_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mobile_push_registrations_device_bundle_env` ON `mobile_push_registrations` (`device_id`,`platform`,`app_bundle_id`,`apns_environment`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mobile_push_registrations_push_token` ON `mobile_push_registrations` (`push_token`);--> statement-breakpoint
CREATE INDEX `idx_mobile_push_registrations_device_updated_at` ON `mobile_push_registrations` (`device_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`mesh_id` text NOT NULL,
	`name` text NOT NULL,
	`host_name` text,
	`advertise_scope` text NOT NULL,
	`broker_url` text,
	`tailnet_name` text,
	`capabilities_json` text,
	`labels_json` text,
	`metadata_json` text,
	`last_seen_at` integer,
	`registered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nodes_mesh_id` ON `nodes` (`mesh_id`);--> statement-breakpoint
CREATE TABLE `runtime_session_aliases` (
	`alias` text NOT NULL,
	`session_id` text NOT NULL,
	`alias_kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`node_id` text NOT NULL,
	`harness` text NOT NULL,
	`transport` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`alias`, `session_id`),
	FOREIGN KEY (`session_id`) REFERENCES `runtime_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `agent_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_session_aliases_alias` ON `runtime_session_aliases` (`alias`,"last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_aliases_session` ON `runtime_session_aliases` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_aliases_expires` ON `runtime_session_aliases` (`expires_at`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `runtime_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`node_id` text NOT NULL,
	`harness` text NOT NULL,
	`transport` text NOT NULL,
	`state` text NOT NULL,
	`primary_alias` text NOT NULL,
	`external_session_id` text,
	`cwd` text,
	`project_root` text,
	`started_at` integer,
	`last_seen_at` integer NOT NULL,
	`ended_at` integer,
	`expires_at` integer,
	`metadata_json` text,
	`created_at` integer DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `agent_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_sessions_agent_last_seen` ON `runtime_sessions` (`agent_id`,"last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runtime_sessions_endpoint_last_seen` ON `runtime_sessions` (`endpoint_id`,"last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runtime_sessions_external` ON `runtime_sessions` (`external_session_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_sessions_expires` ON `runtime_sessions` (`expires_at`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `scout_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`asked_label` text NOT NULL,
	`detail` text NOT NULL,
	`invocation_id` text,
	`conversation_id` text,
	`requester_id` text,
	`dispatcher_node_id` text NOT NULL,
	`dispatched_at` integer NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scout_dispatches_dispatched_at` ON `scout_dispatches` ("dispatched_at" desc);--> statement-breakpoint
CREATE INDEX `idx_scout_dispatches_conversation_ts` ON `scout_dispatches` (`conversation_id`,"dispatched_at" desc);--> statement-breakpoint
CREATE TABLE `thread_cursors` (
	`conversation_id` text NOT NULL,
	`authority_node_id` text NOT NULL,
	`last_applied_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `authority_node_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authority_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `thread_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`authority_node_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`ts` integer NOT NULL,
	`payload_json` text NOT NULL,
	`notification_json` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authority_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_thread_events_conversation_seq` ON `thread_events` (`conversation_id`,"seq" desc);--> statement-breakpoint
CREATE INDEX `idx_thread_events_conversation_ts` ON `thread_events` (`conversation_id`,"ts" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_events_conversation_id_seq_unique` ON `thread_events` (`conversation_id`,`seq`);