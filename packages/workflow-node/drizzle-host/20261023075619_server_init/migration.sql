CREATE TABLE `workflow_versions` (
	`workflow_id` text NOT NULL,
	`digest` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `workflow_versions_pk` PRIMARY KEY(`workflow_id`, `digest`)
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`workflow_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`latest_digest` text NOT NULL,
	`layout_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
