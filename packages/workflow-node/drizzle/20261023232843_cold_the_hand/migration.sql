CREATE TABLE `conversation_events` (
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`turn_id` text,
	`event_json` text NOT NULL,
	CONSTRAINT `conversation_events_pk` PRIMARY KEY(`conversation_id`, `sequence`),
	CONSTRAINT `fk_conversation_events_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_turns` (
	`conversation_id` text NOT NULL,
	`id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text,
	`record_json` text NOT NULL,
	CONSTRAINT `conversation_turns_pk` PRIMARY KEY(`conversation_id`, `id`),
	CONSTRAINT `fk_conversation_turns_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY,
	`record_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_events_turn_idx` ON `conversation_events` (`conversation_id`,`turn_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turn_number_idx` ON `conversation_turns` (`conversation_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turn_request_idx` ON `conversation_turns` (`conversation_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `conversation_turn_queue_idx` ON `conversation_turns` (`conversation_id`,`status`,`number`);