CREATE TABLE `workspace_leases` (
	`lease_id` text PRIMARY KEY,
	`workspace` text NOT NULL,
	`write_scopes_json` text NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_leases_workspace_idx` ON `workspace_leases` (`workspace`);