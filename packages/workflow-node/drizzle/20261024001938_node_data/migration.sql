CREATE TABLE `node_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL,
	`namespace` text NOT NULL,
	`owner` text NOT NULL,
	`scope_key` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_data_key_idx` ON `node_data` (`run_id`,`owner`,`collection`,`key`);--> statement-breakpoint
CREATE INDEX `node_data_node_idx` ON `node_data` (`run_id`,`node_id`,`collection`);