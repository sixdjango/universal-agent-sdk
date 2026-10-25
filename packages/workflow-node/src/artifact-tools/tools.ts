import type { ContextManifest } from '@universal-agent/workflow-contract';
import { ISSUES_COLLECTION, type NodeDataAccess, type NodeDataRecord, type ScopedArtifactReader } from '@universal-agent/workflow-runtime';
import { z } from 'zod';

/** MCP server name agents see; tools appear as e.g. `ua-workflow.read_artifact`. */
export const ARTIFACT_MCP_SERVER_NAME = 'ua-workflow';

/** An MCP `CallToolResult` with text content. */
export interface ArtifactToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Tool names, descriptions and input shapes, shared by the HTTP host and the stdio bridge. */
export const ARTIFACT_TOOLS = {
  list_context_inputs: {
    description:
      'Lists every input bound to this workflow step: where it came from, whether its content is already in your prompt, and the artifact id to read when it is not. remainingReadQuotaBytes is null when no cumulative read quota is configured.',
    inputSchema: {},
  },
  read_artifact: {
    description:
      'Reads one page of an artifact handed to this step (by artifact id). Long artifacts are paged: call again with nextOffsetBytes until hasMore is false, or pass a section heading to read just that section. remainingReadQuotaBytes is null when no cumulative read quota is configured.',
    inputSchema: {
      artifactId: z.string().min(1).describe('Artifact id from the prompt or list_context_inputs'),
      offsetBytes: z.number().int().min(0).optional().describe('Byte offset to start at (default 0)'),
      maxBytes: z.number().int().positive().optional().describe('Bytes to read (capped by the page size)'),
      section: z.string().optional().describe('Markdown heading to read instead of a byte range'),
    },
  },
  data_put: {
    description:
      'Saves intermediate data for this step (progress, partial results, notes, metrics) under collection/key, replacing what was there. With shared: true it goes to data every step of this run can read. Values are JSON, up to 1 MB.',
    inputSchema: {
      collection: z.string().min(1).describe('Group name, e.g. "progress" or "findings"'),
      key: z.string().min(1).describe('Record name within the collection'),
      value: z.unknown().describe('Any JSON value'),
      shared: z.boolean().optional().describe('Store it for the whole run instead of this step'),
    },
  },
  data_append: {
    description: 'Adds a record with a generated key to a collection of this step (or of the run with shared: true), e.g. a log line or a finding.',
    inputSchema: {
      collection: z.string().min(1),
      value: z.unknown().describe('Any JSON value'),
      shared: z.boolean().optional(),
    },
  },
  log_issue: {
    description:
      'Logs a problem you knowingly leave for later (a compromise, a known gap) so it is handed over to a person at the end of the run. Goes to the run-wide "issues" collection.',
    inputSchema: {
      message: z.string().min(1).describe('What is wrong or missing, and what a fix would be'),
      severity: z.enum(['critical', 'major', 'minor', 'info']).optional().describe('Default minor'),
      file: z.string().min(1).optional().describe('File it concerns, relative to the workspace'),
      line: z.number().int().positive().optional(),
    },
  },
  list_findings: {
    description:
      "Lists everything still open in this run, most severe first: what each review's latest round left (a PASS can carry minor findings) and the issues steps logged.",
    inputSchema: {},
  },
  data_get: {
    description:
      "Reads one saved record: this step's by default, another step's with nodeId, or the run's shared data with shared: true. Returns null when there is none.",
    inputSchema: {
      collection: z.string().min(1),
      key: z.string().min(1),
      nodeId: z.string().min(1).optional().describe("Another step's id, to read what it saved"),
      shared: z.boolean().optional(),
    },
  },
  data_list: {
    description:
      "Lists saved records, oldest first: this step's by default, another step's with nodeId (all its loop rounds / items), or the run's shared data with shared: true. Page with afterId.",
    inputSchema: {
      collection: z.string().min(1).optional(),
      nodeId: z.string().min(1).optional(),
      shared: z.boolean().optional(),
      afterId: z.number().int().min(0).optional().describe('Only records written after this id'),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
} as const;

/** Everything a step's tools act on; each part is optional (scripts have no manifest). */
export interface WorkflowToolContext {
  readonly manifest?: ContextManifest;
  readonly reader?: ScopedArtifactReader;
  readonly data?: NodeDataAccess;
}

/** What tool results show of a record. */
function publicRecord(record: NodeDataRecord) {
  return {
    id: record.id,
    namespace: record.namespace,
    nodeId: record.nodeId,
    scopeKey: record.scopeKey,
    collection: record.collection,
    key: record.key,
    value: record.value,
    updatedAtMs: record.updatedAtMs,
  };
}

export type ArtifactToolName = keyof typeof ARTIFACT_TOOLS;

const text = (value: string, isError = false): ArtifactToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Runs a tool for one attempt. Reads go through the attempt's scoped reader, so only
 * artifacts its manifest authorizes are readable, the read quota applies, and every read
 * is recorded as a receipt on the attempt.
 */
export async function runArtifactTool(context: WorkflowToolContext, name: string, args: unknown): Promise<ArtifactToolResult> {
  try {
    if (name === 'log_issue' || name === 'list_findings') {
      const data = context.data;
      if (!data) return text('Step data is not available here', true);
      if (name === 'list_findings') {
        if (!data.findings) return text('Findings are not available here', true);
        return text(JSON.stringify(await data.findings(), null, 2));
      }
      const input = z.object(ARTIFACT_TOOLS.log_issue.inputSchema).parse(args ?? {});
      const record = await data.append(ISSUES_COLLECTION, { message: input.message, severity: input.severity ?? 'minor', ...(input.file ? { file: input.file } : {}), ...(input.line ? { line: input.line } : {}) }, { shared: true });
      return text(JSON.stringify(publicRecord(record), null, 2));
    }
    if (name.startsWith('data_')) {
      const data = context.data;
      if (!data) return text('Step data is not available here', true);
      const json = (value: unknown) => text(JSON.stringify(value, null, 2));
      switch (name) {
        case 'data_put': {
          const input = z.object(ARTIFACT_TOOLS.data_put.inputSchema).parse(args ?? {});
          return json(publicRecord(await data.put(input.collection, input.key, input.value, { shared: input.shared ?? false })));
        }
        case 'data_append': {
          const input = z.object(ARTIFACT_TOOLS.data_append.inputSchema).parse(args ?? {});
          return json(publicRecord(await data.append(input.collection, input.value, { shared: input.shared ?? false })));
        }
        case 'data_get': {
          const input = z.object(ARTIFACT_TOOLS.data_get.inputSchema).parse(args ?? {});
          const record = await data.get(input.collection, input.key, {
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            shared: input.shared ?? false,
          });
          return json(record ? publicRecord(record) : null);
        }
        case 'data_list': {
          const input = z.object(ARTIFACT_TOOLS.data_list.inputSchema).parse(args ?? {});
          const records = await data.list({
            ...(input.collection ? { collection: input.collection } : {}),
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            shared: input.shared ?? false,
          });
          return json(records.map(publicRecord));
        }
      }
    }
    if (!context.manifest || !context.reader) {
      return text('No inputs or artifacts were handed to this step', true);
    }
    const { manifest, reader } = context;
    if (name === 'list_context_inputs') {
      const inputs = manifest.entries.map((entry) => ({
        port: entry.portName,
        from: `${entry.sourceNodeId}.${entry.sourcePort}`,
        delivery: entry.mode === 'inline' ? 'inline (already in your prompt)' : 'artifact_ref (read it with read_artifact)',
        ...(entry.artifactRef
          ? {
              artifactId: entry.artifactRef.artifactId,
              sizeBytes: entry.artifactRef.sizeBytes,
              ...(entry.artifactRef.summary ? { summary: entry.artifactRef.summary } : {}),
              ...(entry.artifactRef.sections?.length ? { sections: entry.artifactRef.sections } : {}),
            }
          : {}),
      }));
      return text(
        JSON.stringify(
          { inputs, pageBytes: manifest.pageReadBytes, remainingReadQuotaBytes: reader.getRemainingQuotaBytes() },
          null,
          2
        )
      );
    }
    if (name === 'read_artifact') {
      const input = z.object(ARTIFACT_TOOLS.read_artifact.inputSchema).parse(args ?? {});
      const page = await reader.readPage(input.artifactId, {
        ...(input.offsetBytes !== undefined ? { offsetBytes: input.offsetBytes } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        ...(input.section !== undefined ? { section: input.section } : {}),
      });
      const meta = {
        artifactId: page.artifactId,
        offsetBytes: page.offsetBytes,
        readBytes: page.readBytes,
        totalBytes: page.totalBytes,
        hasMore: page.hasMore,
        ...(page.nextOffsetBytes !== undefined ? { nextOffsetBytes: page.nextOffsetBytes } : {}),
        ...(page.section ? { section: page.section } : {}),
        remainingReadQuotaBytes: reader.getRemainingQuotaBytes(),
      };
      return text(`${page.content}\n\n---\n${JSON.stringify(meta)}`);
    }
    return text(`Unknown tool "${name}"`, true);
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}
