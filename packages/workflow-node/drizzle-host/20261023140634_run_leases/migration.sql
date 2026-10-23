CREATE TABLE `run_leases` (
	`run_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`expires_at_ms` integer NOT NULL
);
