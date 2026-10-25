CREATE TABLE `conversation_sources` (
	`conversation_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `conversation_sources_pk` PRIMARY KEY(`conversation_id`, `key`),
	CONSTRAINT `fk_conversation_sources_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`)
);
--> statement-breakpoint
CREATE INDEX `conversation_source_lookup_idx` ON `conversation_sources` (`namespace`,`key`,`value`,`conversation_id`);