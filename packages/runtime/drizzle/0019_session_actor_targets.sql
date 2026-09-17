PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_activity_items` (
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
	FOREIGN KEY (`agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_activity_items`("id", "kind", "ts", "conversation_id", "message_id", "invocation_id", "flight_id", "record_id", "actor_id", "counterpart_id", "agent_id", "workspace_root", "session_id", "title", "summary", "payload_json") SELECT "id", "kind", "ts", "conversation_id", "message_id", "invocation_id", "flight_id", "record_id", "actor_id", "counterpart_id", "agent_id", "workspace_root", "session_id", "title", "summary", "payload_json" FROM `activity_items`;--> statement-breakpoint
DROP TABLE `activity_items`;--> statement-breakpoint
ALTER TABLE `__new_activity_items` RENAME TO `activity_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX idx_activity_items_agent_ts
  ON activity_items (agent_id, ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_actor_ts
  ON activity_items (actor_id, ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_conversation_ts
  ON activity_items (conversation_id, ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_ts
  ON activity_items (ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_workspace_ts
  ON activity_items (workspace_root, ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_kind_ts
  ON activity_items (kind, ts DESC);--> statement-breakpoint
CREATE INDEX idx_activity_items_session_ts
  ON activity_items (session_id, ts DESC);--> statement-breakpoint
CREATE TABLE `__new_agent_endpoints` (
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
	FOREIGN KEY (`agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_agent_endpoints`("id", "agent_id", "node_id", "harness", "transport", "state", "address", "session_id", "pane", "cwd", "project_root", "metadata_json", "updated_at") SELECT "id", "agent_id", "node_id", "harness", "transport", "state", "address", "session_id", "pane", "cwd", "project_root", "metadata_json", "updated_at" FROM `agent_endpoints`;--> statement-breakpoint
DROP TABLE `agent_endpoints`;--> statement-breakpoint
ALTER TABLE `__new_agent_endpoints` RENAME TO `agent_endpoints`;--> statement-breakpoint
CREATE INDEX idx_agent_endpoints_agent_updated_at
  ON agent_endpoints (agent_id, updated_at DESC);--> statement-breakpoint
CREATE INDEX idx_agent_endpoints_roster_recency
  ON agent_endpoints (
    CASE
      WHEN updated_at IS NULL THEN NULL
      WHEN CAST(updated_at AS REAL) < 1000000000000
        THEN CAST(CAST(updated_at AS REAL) * 1000 AS INTEGER)
      ELSE CAST(updated_at AS INTEGER)
    END DESC,
    agent_id
  );--> statement-breakpoint
CREATE INDEX idx_agent_endpoints_node_id
  ON agent_endpoints (node_id);--> statement-breakpoint
CREATE TABLE `__new_flights` (
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
	FOREIGN KEY (`target_agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_flights`("id", "invocation_id", "requester_id", "target_agent_id", "state", "summary", "output", "error", "labels_json", "metadata_json", "started_at", "completed_at") SELECT "id", "invocation_id", "requester_id", "target_agent_id", "state", "summary", "output", "error", "labels_json", "metadata_json", "started_at", "completed_at" FROM `flights`;--> statement-breakpoint
DROP TABLE `flights`;--> statement-breakpoint
ALTER TABLE `__new_flights` RENAME TO `flights`;--> statement-breakpoint
CREATE INDEX idx_flights_target_state
  ON flights (target_agent_id, state);--> statement-breakpoint
CREATE INDEX idx_flights_invocation_id
  ON flights (invocation_id);--> statement-breakpoint
CREATE TABLE `__new_invocations` (
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
	`flight_id` text,
	`state` text,
	`summary` text,
	`output` text,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`flight_metadata_json` text,
	`execution_resolution_json` text,
	FOREIGN KEY (`requester_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requester_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`collaboration_record_id`) REFERENCES `collaboration_records`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_invocations`("id", "requester_id", "requester_node_id", "target_agent_id", "target_node_id", "action", "task", "collaboration_record_id", "conversation_id", "message_id", "context_json", "execution_json", "ensure_awake", "stream", "timeout_ms", "labels_json", "metadata_json", "created_at", "flight_id", "state", "summary", "output", "error", "started_at", "completed_at", "flight_metadata_json", "execution_resolution_json") SELECT "id", "requester_id", "requester_node_id", "target_agent_id", "target_node_id", "action", "task", "collaboration_record_id", "conversation_id", "message_id", "context_json", "execution_json", "ensure_awake", "stream", "timeout_ms", "labels_json", "metadata_json", "created_at", "flight_id", "state", "summary", "output", "error", "started_at", "completed_at", "flight_metadata_json", "execution_resolution_json" FROM `invocations`;--> statement-breakpoint
DROP TABLE `invocations`;--> statement-breakpoint
ALTER TABLE `__new_invocations` RENAME TO `invocations`;--> statement-breakpoint
CREATE INDEX idx_invocations_target_created_at
  ON invocations (target_agent_id, created_at);--> statement-breakpoint
CREATE INDEX idx_invocations_requester_created_at
  ON invocations (requester_id, created_at DESC);--> statement-breakpoint
CREATE INDEX idx_invocations_conversation_created_at
  ON invocations (conversation_id, created_at DESC);--> statement-breakpoint
CREATE INDEX idx_invocations_requester_node_id
  ON invocations (requester_node_id);--> statement-breakpoint
CREATE INDEX idx_invocations_target_node_id
  ON invocations (target_node_id);--> statement-breakpoint
CREATE TABLE `__new_runtime_session_aliases` (
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
	FOREIGN KEY (`agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `agent_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_runtime_session_aliases`("alias", "session_id", "alias_kind", "agent_id", "endpoint_id", "node_id", "harness", "transport", "first_seen_at", "last_seen_at", "expires_at") SELECT "alias", "session_id", "alias_kind", "agent_id", "endpoint_id", "node_id", "harness", "transport", "first_seen_at", "last_seen_at", "expires_at" FROM `runtime_session_aliases`;--> statement-breakpoint
DROP TABLE `runtime_session_aliases`;--> statement-breakpoint
ALTER TABLE `__new_runtime_session_aliases` RENAME TO `runtime_session_aliases`;--> statement-breakpoint
CREATE INDEX idx_runtime_session_aliases_alias
  ON runtime_session_aliases (alias, last_seen_at DESC);--> statement-breakpoint
CREATE INDEX idx_runtime_session_aliases_session
  ON runtime_session_aliases (session_id);--> statement-breakpoint
CREATE INDEX idx_runtime_session_aliases_endpoint
  ON runtime_session_aliases (endpoint_id);--> statement-breakpoint
CREATE INDEX idx_runtime_session_aliases_node_id
  ON runtime_session_aliases (node_id);--> statement-breakpoint
CREATE INDEX idx_runtime_session_aliases_expires
  ON runtime_session_aliases (expires_at)
  WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_runtime_sessions` (
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
	FOREIGN KEY (`agent_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `agent_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_runtime_sessions`("id", "agent_id", "endpoint_id", "node_id", "harness", "transport", "state", "primary_alias", "external_session_id", "cwd", "project_root", "started_at", "last_seen_at", "ended_at", "expires_at", "metadata_json", "created_at", "updated_at") SELECT "id", "agent_id", "endpoint_id", "node_id", "harness", "transport", "state", "primary_alias", "external_session_id", "cwd", "project_root", "started_at", "last_seen_at", "ended_at", "expires_at", "metadata_json", "created_at", "updated_at" FROM `runtime_sessions`;--> statement-breakpoint
DROP TABLE `runtime_sessions`;--> statement-breakpoint
ALTER TABLE `__new_runtime_sessions` RENAME TO `runtime_sessions`;--> statement-breakpoint
CREATE INDEX idx_runtime_sessions_agent_last_seen
  ON runtime_sessions (agent_id, last_seen_at DESC);--> statement-breakpoint
CREATE INDEX idx_runtime_sessions_endpoint_last_seen
  ON runtime_sessions (endpoint_id, last_seen_at DESC);--> statement-breakpoint
CREATE INDEX idx_runtime_sessions_node_id
  ON runtime_sessions (node_id);--> statement-breakpoint
CREATE INDEX idx_runtime_sessions_external
  ON runtime_sessions (external_session_id);--> statement-breakpoint
CREATE INDEX idx_runtime_sessions_expires
  ON runtime_sessions (expires_at)
  WHERE expires_at IS NOT NULL;