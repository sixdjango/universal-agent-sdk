import {
  type Clock,
  MAX_NODE_DATA_VALUE_BYTES,
  NodeDataError,
  type NodeDataQuery,
  type NodeDataRecord,
  type NodeDataStore,
  type NodeDataWrite,
  nodeDataOwner,
  SystemClock,
} from '@universal-agent/workflow-runtime';
import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import type { WorkflowDatabase } from './database';
import { nodeData } from './schema';

const NAME = /^[\w.:/-]{1,128}$/;

function toRecord(row: typeof nodeData.$inferSelect): NodeDataRecord {
  return {
    id: row.id,
    runId: row.runId,
    namespace: row.namespace,
    scopeKey: row.scopeKey,
    nodeId: row.nodeId,
    attemptId: row.attemptId,
    collection: row.collection,
    key: row.key,
    value: row.value,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

/**
 * `NodeDataStore` in the workflow database. Every write gets a new, increasing id (an update
 * replaces the row), so readers can poll for changes with `afterId`.
 */
export class SqliteNodeDataStore implements NodeDataStore {
  private readonly db: WorkflowDatabase;
  private readonly clock: Clock;

  constructor(options: { db: WorkflowDatabase; clock?: Clock }) {
    this.db = options.db;
    this.clock = options.clock ?? new SystemClock();
  }

  async write(input: NodeDataWrite): Promise<NodeDataRecord> {
    if (!NAME.test(input.collection) || (input.key !== undefined && !NAME.test(input.key))) {
      throw new NodeDataError('Collections and keys are 1-128 letters, digits or . : / _ -');
    }
    const value = input.value ?? null;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > MAX_NODE_DATA_VALUE_BYTES) {
      throw new NodeDataError(`Value is ${size} bytes; records hold at most ${MAX_NODE_DATA_VALUE_BYTES} (store large results as artifacts)`);
    }
    const owner = nodeDataOwner(input);
    const now = this.clock.nowMs();
    return this.db.transaction(
      (tx) => {
        let createdAtMs = now;
        if (input.key !== undefined) {
          const previous = tx
            .select({ id: nodeData.id, createdAtMs: nodeData.createdAtMs })
            .from(nodeData)
            .where(and(eq(nodeData.runId, input.runId), eq(nodeData.owner, owner), eq(nodeData.collection, input.collection), eq(nodeData.key, input.key)))
            .get();
          if (previous) {
            createdAtMs = previous.createdAtMs;
            tx.delete(nodeData).where(eq(nodeData.id, previous.id)).run();
          }
        }
        const row = tx
          .insert(nodeData)
          .values({
            runId: input.runId,
            namespace: input.namespace,
            owner,
            scopeKey: input.scopeKey,
            nodeId: input.nodeId,
            attemptId: input.attemptId,
            collection: input.collection,
            // Appended records are keyed by their id, set right after the insert.
            key: input.key ?? `pending:${now}:${Math.random()}`,
            value,
            createdAtMs,
            updatedAtMs: now,
          })
          .returning()
          .get();
        if (input.key !== undefined) return toRecord(row);
        return toRecord(tx.update(nodeData).set({ key: String(row.id) }).where(eq(nodeData.id, row.id)).returning().get());
      },
      { behavior: 'immediate' }
    );
  }

  async query(query: NodeDataQuery): Promise<NodeDataRecord[]> {
    const where: SQL[] = [eq(nodeData.runId, query.runId)];
    if (query.namespace) where.push(eq(nodeData.namespace, query.namespace));
    if (query.nodeId) where.push(eq(nodeData.nodeId, query.nodeId));
    if (query.scopeKey) where.push(eq(nodeData.scopeKey, query.scopeKey));
    if (query.collection) where.push(eq(nodeData.collection, query.collection));
    if (query.key) where.push(eq(nodeData.key, query.key));
    if (query.afterId !== undefined) where.push(gt(nodeData.id, query.afterId));
    return this.db
      .select()
      .from(nodeData)
      .where(and(...where))
      .orderBy(asc(nodeData.id))
      .limit(query.limit ?? 200)
      .all()
      .map(toRecord);
  }
}
