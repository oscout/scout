CREATE TABLE `conversation_projection_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projection_id` text NOT NULL,
	`ts` integer NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_events_projection_seq` ON `conversation_projection_events` (`projection_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_events_ts` ON `conversation_projection_events` (`ts`);--> statement-breakpoint
CREATE TABLE `conversation_projection_items` (
	`feed_id` text PRIMARY KEY NOT NULL,
	`entity_kind` text NOT NULL,
	`kind` text NOT NULL,
	`conversation_id` text,
	`runtime_session_id` text,
	`source` text,
	`source_session_id` text,
	`title` text,
	`alias` text,
	`natural_key` text,
	`project_root` text,
	`harness` text,
	`model` text,
	`effort` text,
	`agent_id` text,
	`agent_name` text,
	`current_branch` text,
	`authority_node_id` text,
	`authority_node_name` text,
	`parent_conversation_id` text,
	`anchor_message_id` text,
	`activity_state` text NOT NULL,
	`last_message_id` text,
	`last_message_at` integer,
	`last_activity_at` integer NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`participant_count` integer DEFAULT 0 NOT NULL,
	`preview` text,
	`last_engaged_at` integer,
	`source_fresh_at` integer,
	`visibility_state` text DEFAULT 'visible' NOT NULL,
	`updated_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "conversation_projection_items_entity_kind_check" CHECK("conversation_projection_items"."entity_kind" IN ('scout_conversation', 'observed_session')),
	CONSTRAINT "conversation_projection_items_visibility_check" CHECK("conversation_projection_items"."visibility_state" IN ('visible', 'hidden'))
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_recent` ON `conversation_projection_items` (`visibility_state`,"last_activity_at" desc,`feed_id`);--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_project_recent` ON `conversation_projection_items` (`project_root`,`visibility_state`,"last_activity_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conversation_projection_conversation` ON `conversation_projection_items` (`conversation_id`) WHERE conversation_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `conversation_projection_meta` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`projection_id` text NOT NULL,
	`projection_version` integer NOT NULL,
	`head_seq` integer NOT NULL,
	`min_replayable_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "conversation_projection_meta_singleton_check" CHECK("conversation_projection_meta"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `conversation_projection_sources` (
	`source` text NOT NULL,
	`source_session_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`source`, `source_session_id`),
	FOREIGN KEY (`feed_id`) REFERENCES `conversation_projection_items`(`feed_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_projection_sources_feed` ON `conversation_projection_sources` (`feed_id`);