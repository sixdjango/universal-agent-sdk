import type { ContextManifest } from '@universal-agent/workflow-contract';
import type { ScopedArtifactReader } from '@universal-agent/workflow-runtime';
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
      'Lists every input bound to this workflow step: where it came from, whether its content is already in your prompt, and the artifact id to read when it is not.',
    inputSchema: {},
  },
  read_artifact: {
    description:
      'Reads one page of an artifact handed to this step (by artifact id). Long artifacts are paged: call again with nextOffsetBytes until hasMore is false, or pass a section heading to read just that section.',
    inputSchema: {
      artifactId: z.string().min(1).describe('Artifact id from the prompt or list_context_inputs'),
      offsetBytes: z.number().int().min(0).optional().describe('Byte offset to start at (default 0)'),
      maxBytes: z.number().int().positive().optional().describe('Bytes to read (capped by the page size)'),
      section: z.string().optional().describe('Markdown heading to read instead of a byte range'),
    },
  },
} as const;

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
export async function runArtifactTool(
  context: { readonly manifest: ContextManifest; readonly reader: ScopedArtifactReader },
  name: string,
  args: unknown
): Promise<ArtifactToolResult> {
  try {
    if (name === 'list_context_inputs') {
      const inputs = context.manifest.entries.map((entry) => ({
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
          { inputs, pageBytes: context.manifest.pageReadBytes, remainingReadQuotaBytes: context.reader.getRemainingQuotaBytes() },
          null,
          2
        )
      );
    }
    if (name === 'read_artifact') {
      const input = z.object(ARTIFACT_TOOLS.read_artifact.inputSchema).parse(args ?? {});
      const page = await context.reader.readPage(input.artifactId, {
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
        remainingReadQuotaBytes: context.reader.getRemainingQuotaBytes(),
      };
      return text(`${page.content}\n\n---\n${JSON.stringify(meta)}`);
    }
    return text(`Unknown tool "${name}"`, true);
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}
