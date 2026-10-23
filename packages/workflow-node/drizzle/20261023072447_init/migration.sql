CREATE TABLE `artifact_blobs` (
	`sha256` text PRIMARY KEY,
	`size_bytes` integer NOT NULL,
	`content` blob,
	`file_path` text
);
--> statement-breakpoint
CREATE TABLE `artifact_read_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`offset_bytes` integer NOT NULL,
	`read_bytes` integer NOT NULL,
	`section` text,
	`timestamp_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`artifact_id` text PRIMARY KEY,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`producer_run_id` text NOT NULL,
	`producer_node_id` text NOT NULL,
	`producer_attempt_id` text NOT NULL,
	`port_name` text NOT NULL,
	`summary` text,
	`sections_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assessments` (
	`run_id` text NOT NULL,
	`assessment_id` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`findings_json` text NOT NULL,
	`target_artifact_ids_json` text NOT NULL,
	`independent_reviewer` integer NOT NULL,
	`stale` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `assessments_pk` PRIMARY KEY(`run_id`, `assessment_id`)
);
--> statement-breakpoint
CREATE TABLE `chief_interventions` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`trigger` text NOT NULL,
	`scope_key` text,
	`node_id` text,
	`rationale` text NOT NULL,
	`applied_json` text NOT NULL,
	`rejected_json` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	CONSTRAINT `chief_interventions_pk` PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `context_manifests` (
	`run_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`total_inline_bytes` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `context_manifests_pk` PRIMARY KEY(`run_id`, `manifest_id`)
);
--> statement-breakpoint
CREATE TABLE `definition_edges` (
	`definition_digest` text NOT NULL,
	`scope_path` text NOT NULL,
	`edge_id` text NOT NULL,
	`edge_kind` text NOT NULL,
	`from_node_id` text NOT NULL,
	`from_port` text,
	`to_node_id` text NOT NULL,
	`to_port` text,
	`required` integer,
	`delivery` text,
	`condition_json` text,
	CONSTRAINT `definition_edges_pk` PRIMARY KEY(`definition_digest`, `scope_path`, `edge_id`)
);
--> statement-breakpoint
CREATE TABLE `definition_nodes` (
	`definition_digest` text NOT NULL,
	`scope_path` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`inputs_json` text NOT NULL,
	`outputs_json` text NOT NULL,
	`write_scopes_json` text NOT NULL,
	CONSTRAINT `definition_nodes_pk` PRIMARY KEY(`definition_digest`, `scope_path`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `edge_deliveries` (
	`run_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`attempt_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`to_port` text NOT NULL,
	`from_node_id` text NOT NULL,
	`from_port` text NOT NULL,
	`mode` text NOT NULL,
	`artifact_id` text,
	`byte_size` integer NOT NULL,
	`selection_reason` text NOT NULL,
	CONSTRAINT `edge_deliveries_pk` PRIMARY KEY(`run_id`, `manifest_id`, `to_port`)
);
--> statement-breakpoint
CREATE TABLE `node_attempts` (
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`node_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`retry_index` integer NOT NULL,
	`round_index` integer NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`context_manifest_id` text,
	`produced_artifact_ids_json` text NOT NULL,
	`assessment_id` text,
	`receipt_json` text,
	`agent_id` text,
	`agent_version` text,
	`agent_digest` text,
	`error` text,
	`started_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	CONSTRAINT `node_attempts_pk` PRIMARY KEY(`run_id`, `attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `node_states` (
	`run_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`latest_attempt_id` text,
	`retry_count` integer NOT NULL,
	`latest_verdict` text,
	`latest_assessment_id` text,
	`active_wait_request_id` text,
	`error` text,
	`outputs_json` text NOT NULL,
	CONSTRAINT `node_states_pk` PRIMARY KEY(`run_id`, `scope_key`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `run_log` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`coordinator_epoch` integer NOT NULL,
	`scope_key` text,
	`node_id` text,
	`mutation_json` text NOT NULL,
	`recorded_at_ms` integer NOT NULL,
	CONSTRAINT `run_log_pk` PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `run_scopes` (
	`run_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`scope_path` text NOT NULL,
	`status` text NOT NULL,
	`round_index` integer,
	`inputs_json` text NOT NULL,
	`outputs_json` text NOT NULL,
	CONSTRAINT `run_scopes_pk` PRIMARY KEY(`run_id`, `scope_key`)
);
--> statement-breakpoint
CREATE TABLE `run_snapshots` (
	`run_id` text PRIMARY KEY,
	`seq` integer NOT NULL,
	`state_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY,
	`definition_digest` text NOT NULL,
	`status` text NOT NULL,
	`seq` integer NOT NULL,
	`coordinator_epoch` integer NOT NULL,
	`inputs_json` text NOT NULL,
	`outputs_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wait_requests` (
	`run_id` text NOT NULL,
	`request_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`status` text NOT NULL,
	`prompt` text NOT NULL,
	`options_json` text NOT NULL,
	`required_role` text,
	`session_binding_json` text,
	`response_json` text,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `wait_requests_pk` PRIMARY KEY(`run_id`, `request_id`)
);
--> statement-breakpoint
CREATE TABLE `workflow_definitions` (
	`definition_digest` text PRIMARY KEY,
	`definition_id` text NOT NULL,
	`version` text NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifact_read_receipts_attempt_idx` ON `artifact_read_receipts` (`run_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `artifacts_sha256_idx` ON `artifacts` (`sha256`);--> statement-breakpoint
CREATE INDEX `artifacts_producer_idx` ON `artifacts` (`producer_run_id`,`producer_node_id`);--> statement-breakpoint
CREATE INDEX `assessments_node_idx` ON `assessments` (`run_id`,`node_id`);--> statement-breakpoint
CREATE INDEX `chief_interventions_trigger_idx` ON `chief_interventions` (`trigger`);--> statement-breakpoint
CREATE INDEX `context_manifests_attempt_idx` ON `context_manifests` (`run_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `definition_edges_to_idx` ON `definition_edges` (`definition_digest`,`scope_path`,`to_node_id`);--> statement-breakpoint
CREATE INDEX `edge_deliveries_artifact_idx` ON `edge_deliveries` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `edge_deliveries_from_idx` ON `edge_deliveries` (`run_id`,`from_node_id`,`from_port`);--> statement-breakpoint
CREATE INDEX `node_attempts_node_idx` ON `node_attempts` (`run_id`,`scope_key`,`node_id`);--> statement-breakpoint
CREATE INDEX `node_attempts_agent_idx` ON `node_attempts` (`agent_id`,`agent_version`);--> statement-breakpoint
CREATE INDEX `node_states_status_idx` ON `node_states` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `run_log_kind_idx` ON `run_log` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`,`updated_at_ms`);--> statement-breakpoint
CREATE INDEX `wait_requests_status_idx` ON `wait_requests` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_definitions_id_idx` ON `workflow_definitions` (`definition_id`,`version`);