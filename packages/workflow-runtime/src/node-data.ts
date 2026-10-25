import type { OpenFinding } from './findings';
import type { Clock } from './ports';

/**
 * Where a record lives: `node` data belongs to one step (one scope instance, e.g. one loop
 * round or parallel item); `run` data is shared by every step of the run.
 */
export type NodeDataNamespace = 'node' | 'run';

/** One piece of intermediate data a step saved: progress, partial results, notes, metrics. */
export interface NodeDataRecord {
  readonly id: number;
  readonly runId: string;
  readonly namespace: NodeDataNamespace;
  /** Step (and scope instance) that wrote it last. */
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly collection: string;
  readonly key: string;
  readonly value: unknown;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NodeDataWrite {
  readonly runId: string;
  readonly namespace: NodeDataNamespace;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly collection: string;
  /** Omit to append a new record with a generated key. */
  readonly key?: string;
  readonly value: unknown;
}

export interface NodeDataQuery {
  readonly runId: string;
  readonly namespace?: NodeDataNamespace;
  readonly nodeId?: string;
  readonly scopeKey?: string;
  readonly collection?: string;
  readonly key?: string;
  /** Oldest first, after this record id. */
  readonly afterId?: number;
  readonly limit?: number;
}

/**
 * Storage for steps' intermediate data. `node` records are unique per
 * (run, scope, node, collection, key) and `run` records per (run, collection, key); writing
 * an existing key replaces its value.
 */
export interface NodeDataStore {
  write(input: NodeDataWrite): Promise<NodeDataRecord>;
  query(query: NodeDataQuery): Promise<NodeDataRecord[]>;
}

/** Largest value a single record may hold; bigger results belong in an artifact. */
export const MAX_NODE_DATA_VALUE_BYTES = 1024 * 1024;

const NAME = /^[\w.:/-]{1,128}$/;

export class NodeDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeDataError';
  }
}

function checkWrite(input: NodeDataWrite): void {
  if (!NAME.test(input.collection)) {
    throw new NodeDataError(`Collection "${input.collection}" must be 1-128 letters, digits or . : / _ -`);
  }
  if (input.key !== undefined && !NAME.test(input.key)) {
    throw new NodeDataError(`Key "${input.key}" must be 1-128 letters, digits or . : / _ -`);
  }
  const size = new TextEncoder().encode(JSON.stringify(input.value ?? null)).byteLength;
  if (size > MAX_NODE_DATA_VALUE_BYTES) {
    throw new NodeDataError(`Value is ${size} bytes; records hold at most ${MAX_NODE_DATA_VALUE_BYTES} (store large results as artifacts)`);
  }
}

/** Identity of a record within its run: node records are owned by one scope instance of one step. */
export function nodeDataOwner(input: Pick<NodeDataWrite, 'namespace' | 'scopeKey' | 'nodeId'>): string {
  return input.namespace === 'run' ? '' : `${input.scopeKey}#${input.nodeId}`;
}

export class InMemoryNodeDataStore implements NodeDataStore {
  private readonly records: NodeDataRecord[] = [];
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  async write(input: NodeDataWrite): Promise<NodeDataRecord> {
    checkWrite(input);
    const now = this.clock.nowMs();
    const owner = nodeDataOwner(input);
    const index =
      input.key === undefined
        ? -1
        : this.records.findIndex(
            (r) => r.runId === input.runId && nodeDataOwner(r) === owner && r.collection === input.collection && r.key === input.key
          );
    const id = ++this.seq;
    const previous = index >= 0 ? this.records[index] : undefined;
    const record: NodeDataRecord = {
      id,
      runId: input.runId,
      namespace: input.namespace,
      scopeKey: input.scopeKey,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      collection: input.collection,
      key: input.key ?? String(id),
      value: structuredClone(input.value ?? null),
      createdAtMs: previous?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    if (index >= 0) this.records.splice(index, 1);
    this.records.push(record);
    return structuredClone(record);
  }

  async query(query: NodeDataQuery): Promise<NodeDataRecord[]> {
    return this.records
      .filter(
        (r) =>
          r.runId === query.runId &&
          (query.namespace === undefined || r.namespace === query.namespace) &&
          (query.nodeId === undefined || r.nodeId === query.nodeId) &&
          (query.scopeKey === undefined || r.scopeKey === query.scopeKey) &&
          (query.collection === undefined || r.collection === query.collection) &&
          (query.key === undefined || r.key === query.key) &&
          (query.afterId === undefined || r.id > query.afterId)
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, query.limit ?? 200)
      .map((r) => structuredClone(r));
  }
}

/**
 * A step's view of node data, bound to the attempt that runs it. It writes only its own
 * records (or shared run records), and reads its own, shared, or any other step's records.
 */
export interface NodeDataAccess {
  readonly runId: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /** Saves `value` under `collection`/`key`, replacing what was there. */
  put(collection: string, key: string, value: unknown, options?: { shared?: boolean }): Promise<NodeDataRecord>;
  /** Adds a record with a generated key (logs, progress, findings). */
  append(collection: string, value: unknown, options?: { shared?: boolean }): Promise<NodeDataRecord>;
  /**
   * Reads one record. Defaults to this step in this scope; with `nodeId`, another step's
   * record (its instance in this scope if it has one, else its latest anywhere in the run).
   */
  get(collection: string, key: string, options?: { shared?: boolean; nodeId?: string }): Promise<NodeDataRecord | null>;
  /** Lists records, oldest first: this step's by default, another step's, or shared ones. */
  list(options?: { collection?: string; nodeId?: string; shared?: boolean; allScopes?: boolean; afterId?: number; limit?: number }): Promise<NodeDataRecord[]>;
  /** The run's open findings (see `WorkflowRuntime.getOpenFindings`), when the runtime offers them. */
  findings?(): Promise<OpenFinding[]>;
}

export function createNodeDataAccess(
  store: NodeDataStore,
  bound: { runId: string; scopeKey: string; nodeId: string; attemptId: string },
  extras: { findings?: () => Promise<OpenFinding[]> } = {}
): NodeDataAccess {
  const write = (collection: string, key: string | undefined, value: unknown, shared?: boolean) =>
    store.write({
      ...bound,
      namespace: shared ? 'run' : 'node',
      collection,
      ...(key !== undefined ? { key } : {}),
      value,
    });
  return {
    ...bound,
    ...(extras.findings ? { findings: extras.findings } : {}),
    put: (collection, key, value, options) => write(collection, key, value, options?.shared),
    append: (collection, value, options) => write(collection, undefined, value, options?.shared),
    async get(collection, key, options = {}) {
      if (options.shared) {
        return (await store.query({ runId: bound.runId, namespace: 'run', collection, key, limit: 1 }))[0] ?? null;
      }
      const nodeId = options.nodeId ?? bound.nodeId;
      const here = await store.query({ runId: bound.runId, namespace: 'node', nodeId, scopeKey: bound.scopeKey, collection, key, limit: 1 });
      if (here[0] || nodeId === bound.nodeId) return here[0] ?? null;
      const anywhere = await store.query({ runId: bound.runId, namespace: 'node', nodeId, collection, key, limit: 1000 });
      return anywhere.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.id - a.id)[0] ?? null;
    },
    list(options = {}) {
      const nodeId = options.nodeId ?? bound.nodeId;
      return store.query({
        runId: bound.runId,
        namespace: options.shared ? 'run' : 'node',
        ...(options.shared ? {} : { nodeId }),
        // Own records default to this scope; another step's span all its scopes unless narrowed.
        ...(!options.shared && !options.allScopes && nodeId === bound.nodeId ? { scopeKey: bound.scopeKey } : {}),
        ...(options.collection ? { collection: options.collection } : {}),
        ...(options.afterId !== undefined ? { afterId: options.afterId } : {}),
        limit: Math.min(options.limit ?? 100, 500),
      });
    },
  };
}
