CREATE INDEX `idx_agent_endpoints_node_id` ON `agent_endpoints` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_home_node_id` ON `agents` (`home_node_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_authority_node_id` ON `agents` (`authority_node_id`);--> statement-breakpoint
CREATE INDEX `idx_read_cursors_reader_node_id` ON `conversation_read_cursors` (`reader_node_id`);--> statement-breakpoint
CREATE INDEX `idx_deliveries_target_node_id` ON `deliveries` (`target_node_id`);--> statement-breakpoint
CREATE INDEX `idx_invocations_requester_node_id` ON `invocations` (`requester_node_id`);--> statement-breakpoint
CREATE INDEX `idx_invocations_target_node_id` ON `invocations` (`target_node_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_origin_node_id` ON `messages` (`origin_node_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_aliases_node_id` ON `runtime_session_aliases` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_sessions_node_id` ON `runtime_sessions` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_cursors_authority_node_id` ON `thread_cursors` (`authority_node_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_events_authority_node_id` ON `thread_events` (`authority_node_id`);
