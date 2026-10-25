import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SQLite layout for the workflow kit.
 *
 * - Contract tables (`workflow_definitions`, `definition_nodes`, `definition_edges`) are
 *   immutable and keyed by `definition_digest`.
 * - `run_log` is the only source of truth for run state; `run_snapshots` speeds up loads.
 * - Every other run table is a query projection rebuilt from `run_log` in the same transaction.
 * - Run-level ids (attempts, manifests, ...) are only unique within a run, so keys include `run_id`.
 */

const json = (name: string) => text(name, { mode: 'json' });

// Shared chat/execution history. These tables do not require a Flow definition or run.
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  record: json('record_json').notNull(),
});

/** Generic host correlation, indexed independently of graph/run storage. */
export const conversationSources = sqliteTable('conversation_sources', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, t => [
  primaryKey({ columns: [t.conversationId, t.key] }),
  index('conversation_source_lookup_idx').on(t.namespace, t.key, t.value, t.conversationId),
]);

export const conversationTurns = sqliteTable('conversation_turns', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  id: text('id').notNull(),
  number: integer('number').notNull(),
  status: text('status').notNull(),
  idempotencyKey: text('idempotency_key'),
  record: json('record_json').notNull(),
}, t => [
  primaryKey({ columns: [t.conversationId, t.id] }),
  uniqueIndex('conversation_turn_number_idx').on(t.conversationId, t.number),
  uniqueIndex('conversation_turn_request_idx').on(t.conversationId, t.idempotencyKey),
  index('conversation_turn_queue_idx').on(t.conversationId, t.status, t.number),
]);

export const conversationEvents = sqliteTable('conversation_events', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  sequence: integer('sequence').notNull(),
  turnId: text('turn_id'),
  event: json('event_json').notNull(),
}, t => [
  primaryKey({ columns: [t.conversationId, t.sequence] }),
  index('conversation_events_turn_idx').on(t.conversationId, t.turnId, t.sequence),
]);

// ---------------------------------------------------------------------------
// Contract layer
// ---------------------------------------------------------------------------

export const workflowDefinitions = sqliteTable('workflow_definitions', {
  definitionDigest: text('definition_digest').primaryKey(),
  definitionId: text('definition_id').notNull(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  definition: json('definition_json').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [index('workflow_definitions_id_idx').on(t.definitionId, t.version)]);

export const definitionNodes = sqliteTable('definition_nodes', {
  definitionDigest: text('definition_digest').notNull(),
  scopePath: text('scope_path').notNull(),
  nodeId: text('node_id').notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  inputs: json('inputs_json').notNull(),
  outputs: json('outputs_json').notNull(),
  writeScopes: json('write_scopes_json').notNull(),
}, (t) => [primaryKey({ columns: [t.definitionDigest, t.scopePath, t.nodeId] })]);

export const definitionEdges = sqliteTable('definition_edges', {
  definitionDigest: text('definition_digest').notNull(),
  scopePath: text('scope_path').notNull(),
  edgeId: text('edge_id').notNull(),
  edgeKind: text('edge_kind', { enum: ['control', 'data'] }).notNull(),
  fromNodeId: text('from_node_id').notNull(),
  fromPort: text('from_port'),
  toNodeId: text('to_node_id').notNull(),
  toPort: text('to_port'),
  required: integer('required', { mode: 'boolean' }),
  delivery: text('delivery'),
  condition: json('condition_json'),
  /** Control edges only: set on a loop's way back (round limit and what happens after it). */
  loop: json('loop_json'),
}, (t) => [
  primaryKey({ columns: [t.definitionDigest, t.scopePath, t.edgeId] }),
  index('definition_edges_to_idx').on(t.definitionDigest, t.scopePath, t.toNodeId),
]);

// ---------------------------------------------------------------------------
// Run log (source of truth)
// ---------------------------------------------------------------------------

export const runs = sqliteTable('runs', {
  runId: text('run_id').primaryKey(),
  definitionDigest: text('definition_digest').notNull(),
  status: text('status').notNull(),
  seq: integer('seq').notNull(),
  coordinatorEpoch: integer('coordinator_epoch').notNull(),
  inputs: json('inputs_json').notNull(),
  outputs: json('outputs_json').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [index('runs_status_idx').on(t.status, t.updatedAtMs)]);

export const runLog = sqliteTable('run_log', {
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),
  coordinatorEpoch: integer('coordinator_epoch').notNull(),
  /** Denormalized from the mutation for filtering; null when not applicable. */
  scopeKey: text('scope_key'),
  nodeId: text('node_id'),
  mutation: json('mutation_json').notNull(),
  recordedAtMs: integer('recorded_at_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.seq] }),
  index('run_log_kind_idx').on(t.runId, t.kind),
]);

export const runSnapshots = sqliteTable('run_snapshots', {
  runId: text('run_id').primaryKey(),
  seq: integer('seq').notNull(),
  state: json('state_json').notNull(),
});

// ---------------------------------------------------------------------------
// Query projections
// ---------------------------------------------------------------------------

export const runScopes = sqliteTable('run_scopes', {
  runId: text('run_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  scopePath: text('scope_path').notNull(),
  status: text('status').notNull(),
  roundIndex: integer('round_index'),
  inputs: json('inputs_json').notNull(),
  outputs: json('outputs_json').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.scopeKey] })]);

export const nodeStates = sqliteTable('node_states', {
  runId: text('run_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  nodeId: text('node_id').notNull(),
  status: text('status').notNull(),
  latestAttemptId: text('latest_attempt_id'),
  retryCount: integer('retry_count').notNull(),
  latestVerdict: text('latest_verdict'),
  latestAssessmentId: text('latest_assessment_id'),
  activeWaitRequestId: text('active_wait_request_id'),
  error: text('error'),
  outputs: json('outputs_json').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.scopeKey, t.nodeId] }),
  index('node_states_status_idx').on(t.runId, t.status),
]);

export const nodeAttempts = sqliteTable('node_attempts', {
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  nodeId: text('node_id').notNull(),
  invocationId: text('invocation_id').notNull(),
  retryIndex: integer('retry_index').notNull(),
  roundIndex: integer('round_index').notNull(),
  phase: text('phase').notNull(),
  status: text('status').notNull(),
  contextManifestId: text('context_manifest_id'),
  producedArtifactIds: json('produced_artifact_ids_json').notNull(),
  assessmentId: text('assessment_id'),
  receipt: json('receipt_json'),
  /** Agent profile that performed the attempt (null for scripts, gates and role-bound nodes). */
  agentId: text('agent_id'),
  agentVersion: text('agent_version'),
  agentDigest: text('agent_digest'),
  error: text('error'),
  startedAtMs: integer('started_at_ms').notNull(),
  completedAtMs: integer('completed_at_ms'),
}, (t) => [
  primaryKey({ columns: [t.runId, t.attemptId] }),
  index('node_attempts_node_idx').on(t.runId, t.scopeKey, t.nodeId),
  index('node_attempts_agent_idx').on(t.agentId, t.agentVersion),
]);

/** One row per chief intervention, projected from `chief.intervened` events. */
export const chiefInterventions = sqliteTable('chief_interventions', {
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  trigger: text('trigger').notNull(),
  scopeKey: text('scope_key'),
  nodeId: text('node_id'),
  rationale: text('rationale').notNull(),
  applied: json('applied_json').notNull(),
  rejected: json('rejected_json').notNull(),
  timestampMs: integer('timestamp_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.seq] }),
  index('chief_interventions_trigger_idx').on(t.trigger),
]);

export const contextManifests = sqliteTable('context_manifests', {
  runId: text('run_id').notNull(),
  manifestId: text('manifest_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  nodeId: text('node_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  totalInlineBytes: integer('total_inline_bytes').notNull(),
  manifest: json('manifest_json').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.manifestId] }),
  index('context_manifests_attempt_idx').on(t.runId, t.attemptId),
]);

/** One row per input port in a frozen manifest: what each data edge actually delivered. */
export const edgeDeliveries = sqliteTable('edge_deliveries', {
  runId: text('run_id').notNull(),
  manifestId: text('manifest_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  attemptId: text('attempt_id').notNull(),
  toNodeId: text('to_node_id').notNull(),
  toPort: text('to_port').notNull(),
  fromNodeId: text('from_node_id').notNull(),
  fromPort: text('from_port').notNull(),
  mode: text('mode', { enum: ['inline', 'artifact_ref'] }).notNull(),
  artifactId: text('artifact_id'),
  byteSize: integer('byte_size').notNull(),
  selectionReason: text('selection_reason').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.manifestId, t.toPort] }),
  index('edge_deliveries_artifact_idx').on(t.artifactId),
  index('edge_deliveries_from_idx').on(t.runId, t.fromNodeId, t.fromPort),
]);

export const assessments = sqliteTable('assessments', {
  runId: text('run_id').notNull(),
  assessmentId: text('assessment_id').notNull(),
  nodeId: text('node_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  verdict: text('verdict').notNull(),
  summary: text('summary').notNull(),
  findings: json('findings_json').notNull(),
  targetArtifactIds: json('target_artifact_ids_json').notNull(),
  independentReviewer: integer('independent_reviewer', { mode: 'boolean' }).notNull(),
  stale: integer('stale', { mode: 'boolean' }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.assessmentId] }),
  index('assessments_node_idx').on(t.runId, t.nodeId),
]);

export const waitRequests = sqliteTable('wait_requests', {
  runId: text('run_id').notNull(),
  requestId: text('request_id').notNull(),
  scopeKey: text('scope_key').notNull(),
  nodeId: text('node_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  status: text('status').notNull(),
  prompt: text('prompt').notNull(),
  options: json('options_json').notNull(),
  requiredRole: text('required_role'),
  sessionBinding: json('session_binding_json'),
  response: json('response_json'),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.requestId] }),
  index('wait_requests_status_idx').on(t.status),
]);

export const artifactReadReceipts = sqliteTable('artifact_read_receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  receiptId: text('receipt_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  artifactId: text('artifact_id').notNull(),
  offsetBytes: integer('offset_bytes').notNull(),
  readBytes: integer('read_bytes').notNull(),
  section: text('section'),
  timestampMs: integer('timestamp_ms').notNull(),
}, (t) => [index('artifact_read_receipts_attempt_idx').on(t.runId, t.attemptId)]);

// ---------------------------------------------------------------------------
// Artifacts (content-addressed)
// ---------------------------------------------------------------------------

export const artifacts = sqliteTable('artifacts', {
  artifactId: text('artifact_id').primaryKey(),
  sha256: text('sha256').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  producerRunId: text('producer_run_id').notNull(),
  producerNodeId: text('producer_node_id').notNull(),
  producerAttemptId: text('producer_attempt_id').notNull(),
  portName: text('port_name').notNull(),
  summary: text('summary'),
  sections: json('sections_json'),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [
  index('artifacts_sha256_idx').on(t.sha256),
  index('artifacts_producer_idx').on(t.producerRunId, t.producerNodeId),
]);

/** Bytes stored once per digest: inline below the size threshold, otherwise as a file. */
export const artifactBlobs = sqliteTable('artifact_blobs', {
  sha256: text('sha256').primaryKey(),
  sizeBytes: integer('size_bytes').notNull(),
  content: blob('content', { mode: 'buffer' }),
  filePath: text('file_path'),
});

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/**
 * Write leases on workspace paths, shared by every process using this database. Holders renew
 * `expiresAtMs` while they hold a lease; expired rows belong to dead processes and are ignored.
 */
export const workspaceLeases = sqliteTable('workspace_leases', {
  leaseId: text('lease_id').primaryKey(),
  workspace: text('workspace').notNull(),
  writeScopes: json('write_scopes_json').notNull(),
  ownerId: text('owner_id').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
}, (t) => [index('workspace_leases_workspace_idx').on(t.workspace)]);

/**
 * Intermediate data steps save while they work (progress, partial results, notes). `owner` is
 * `<scopeKey>#<nodeId>` for a step's own records and empty for records shared by the run;
 * writing an existing (run, owner, collection, key) replaces its value.
 */
export const nodeData = sqliteTable('node_data', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  namespace: text('namespace', { enum: ['node', 'run'] }).notNull(),
  owner: text('owner').notNull(),
  scopeKey: text('scope_key').notNull(),
  nodeId: text('node_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  collection: text('collection').notNull(),
  key: text('key').notNull(),
  value: json('value_json').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [
  uniqueIndex('node_data_key_idx').on(t.runId, t.owner, t.collection, t.key),
  index('node_data_node_idx').on(t.runId, t.nodeId, t.collection),
]);
