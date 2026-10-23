CREATE TABLE `agent_versions` (
	`agent_id` text NOT NULL,
	`version` text NOT NULL,
	`digest` text NOT NULL,
	`profile_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `agent_versions_pk` PRIMARY KEY(`agent_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`latest_version` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
