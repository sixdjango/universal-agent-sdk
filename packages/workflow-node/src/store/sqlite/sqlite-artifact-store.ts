import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ArtifactVersion, sha256Hex } from '@universal-agent/workflow-contract';
import {
  type ArtifactPageSlice,
  type ArtifactStore,
  type Clock,
  extractMarkdownSections,
  type PutArtifactInput,
  sliceArtifactBytes,
  SystemClock,
} from '@universal-agent/workflow-runtime';
import { eq } from 'drizzle-orm';
import type { WorkflowDatabase } from './database';
import { artifactBlobs, artifacts } from './schema';

export interface SqliteArtifactStoreOptions {
  readonly db: WorkflowDatabase;
  /** Directory for blobs larger than `inlineBlobMaxBytes`. */
  readonly blobsDir: string;
  /** Blobs up to this size live inside SQLite (default 1 MiB). */
  readonly inlineBlobMaxBytes?: number;
  readonly clock?: Clock;
}

/**
 * Content-addressed `ArtifactStore`: metadata rows in `artifacts`, bytes deduplicated by
 * SHA-256 in `artifact_blobs` (inline for small payloads, sharded files for large ones).
 */
export class SqliteArtifactStore implements ArtifactStore {
  private readonly db: WorkflowDatabase;
  private readonly blobsDir: string;
  private readonly inlineBlobMaxBytes: number;
  private readonly clock: Clock;

  constructor(options: SqliteArtifactStoreOptions) {
    this.db = options.db;
    this.blobsDir = options.blobsDir;
    this.inlineBlobMaxBytes = options.inlineBlobMaxBytes ?? 1024 * 1024;
    this.clock = options.clock ?? new SystemClock();
  }

  private blobFilePath(sha256: string): string {
    return join(this.blobsDir, sha256.slice(0, 2), sha256);
  }

  async put(input: PutArtifactInput): Promise<ArtifactVersion> {
    const bytes =
      typeof input.content === 'string'
        ? new TextEncoder().encode(input.content)
        : new Uint8Array(input.content);
    const sha256 = sha256Hex(bytes);
    const textContent =
      typeof input.content === 'string' ? input.content : new TextDecoder().decode(bytes);
    const sections = extractMarkdownSections(textContent);

    const storeInline = bytes.byteLength <= this.inlineBlobMaxBytes;
    const filePath = storeInline ? null : this.blobFilePath(sha256);
    if (filePath) {
      // Written before the row commits; content addressing makes an orphan harmless. Readers
      // never see a partial file: an existing complete blob is reused, otherwise the bytes go
      // to a unique temp file that is renamed into place atomically.
      const existing = await stat(filePath).catch(() => null);
      if (existing?.size !== bytes.byteLength) {
        await mkdir(join(this.blobsDir, sha256.slice(0, 2)), { recursive: true });
        const tempPath = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(tempPath, bytes);
          await rename(tempPath, filePath);
        } finally {
          await rm(tempPath, { force: true });
        }
      }
    }

    const version: ArtifactVersion = {
      artifactId: `art_${sha256.slice(0, 16)}_${randomUUID().slice(0, 8)}`,
      sha256,
      mediaType: input.mediaType ?? 'text/plain',
      sizeBytes: bytes.byteLength,
      producerRunId: input.producerRunId,
      producerNodeId: input.producerNodeId,
      producerAttemptId: input.producerAttemptId,
      portName: input.portName,
      summary: input.summary ?? textContent.slice(0, 240),
      ...(sections.length > 0 ? { sections } : {}),
      uri: filePath ? `file://${filePath}` : `sqlite-blob:${sha256}`,
      createdAtMs: this.clock.nowMs(),
    };

    this.db.transaction((tx) => {
      tx.insert(artifactBlobs)
        .values({
          sha256,
          sizeBytes: bytes.byteLength,
          content: storeInline ? Buffer.from(bytes) : null,
          filePath,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(artifacts)
        .values({
          artifactId: version.artifactId,
          sha256,
          mediaType: version.mediaType,
          sizeBytes: version.sizeBytes,
          producerRunId: version.producerRunId,
          producerNodeId: version.producerNodeId,
          producerAttemptId: version.producerAttemptId,
          portName: version.portName,
          summary: version.summary ?? null,
          sections: version.sections ?? null,
          createdAtMs: version.createdAtMs,
        })
        .run();
    });
    return version;
  }

  async getMeta(artifactId: string): Promise<ArtifactVersion | null> {
    const row = this.db.select().from(artifacts).where(eq(artifacts.artifactId, artifactId)).get();
    if (!row) return null;
    const blobRow = this.db
      .select({ filePath: artifactBlobs.filePath })
      .from(artifactBlobs)
      .where(eq(artifactBlobs.sha256, row.sha256))
      .get();
    return {
      artifactId: row.artifactId,
      sha256: row.sha256,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      producerRunId: row.producerRunId,
      producerNodeId: row.producerNodeId,
      producerAttemptId: row.producerAttemptId,
      portName: row.portName,
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.sections ? { sections: row.sections as string[] } : {}),
      uri: blobRow?.filePath ? `file://${blobRow.filePath}` : `sqlite-blob:${row.sha256}`,
      createdAtMs: row.createdAtMs,
    };
  }

  async readText(artifactId: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(artifactId));
  }

  async readSlice(
    artifactId: string,
    options?: { offsetBytes?: number; maxBytes?: number; section?: string }
  ): Promise<ArtifactPageSlice> {
    return sliceArtifactBytes(artifactId, await this.readBytes(artifactId), options);
  }

  private async readBytes(artifactId: string): Promise<Uint8Array> {
    const row = this.db
      .select({ content: artifactBlobs.content, filePath: artifactBlobs.filePath })
      .from(artifacts)
      .innerJoin(artifactBlobs, eq(artifacts.sha256, artifactBlobs.sha256))
      .where(eq(artifacts.artifactId, artifactId))
      .get();
    if (!row) {
      throw new Error(`Artifact "${artifactId}" not found`);
    }
    if (row.content) {
      return new Uint8Array(row.content);
    }
    if (row.filePath) {
      return new Uint8Array(await readFile(row.filePath));
    }
    throw new Error(`Artifact "${artifactId}" has no stored content`);
  }
}
