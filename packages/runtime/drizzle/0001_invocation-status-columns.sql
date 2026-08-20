ALTER TABLE `invocations` ADD `flight_id` text;--> statement-breakpoint
ALTER TABLE `invocations` ADD `state` text;--> statement-breakpoint
ALTER TABLE `invocations` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `invocations` ADD `output` text;--> statement-breakpoint
ALTER TABLE `invocations` ADD `error` text;--> statement-breakpoint
ALTER TABLE `invocations` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `invocations` ADD `completed_at` integer;