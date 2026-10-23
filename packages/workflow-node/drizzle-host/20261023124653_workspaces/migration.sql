CREATE TABLE `workspaces` (
	`workspace_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`isolation` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workflows` ADD `workspace_bindings_json` text DEFAULT '{}' NOT NULL;