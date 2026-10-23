import type { ArtifactPageSlice } from '../ports';

/** Lists Markdown heading titles, used as an artifact's section index. */
export function extractMarkdownSections(text: string): string[] {
  const sections: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (match?.[1]) {
      sections.push(match[1].trim());
    }
  }
  return sections;
}

function alignUtf8SliceEnd(bytes: Uint8Array, start: number, requestedEnd: number): number {
  if (requestedEnd >= bytes.byteLength) return bytes.byteLength;
  let end = requestedEnd;
  while (end > start && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return end > start ? end : requestedEnd;
}

/**
 * Pages through `bytes` (optionally narrowed to one Markdown `section`) without splitting
 * a UTF-8 code point. Shared by every `ArtifactStore` implementation.
 */
export function sliceArtifactBytes(
  artifactId: string,
  bytes: Uint8Array,
  options?: { offsetBytes?: number; maxBytes?: number; section?: string }
): ArtifactPageSlice {
  let targetBytes = bytes;
  if (options?.section) {
    const fullText = new TextDecoder().decode(bytes);
    const lines = fullText.split('\n');
    const secHeader = options.section.toLowerCase();
    let startLine = -1;
    let endLine = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = /^#{1,6}\s+(.+)$/.exec(lines[i]!.trim());
      if (m?.[1]) {
        if (startLine === -1 && m[1].trim().toLowerCase() === secHeader) {
          startLine = i;
        } else if (startLine !== -1) {
          endLine = i;
          break;
        }
      }
    }
    const sectionText = startLine !== -1 ? lines.slice(startLine, endLine).join('\n') : fullText;
    targetBytes = new TextEncoder().encode(sectionText);
  }

  const totalBytes = targetBytes.byteLength;
  const offsetBytes = Math.min(Math.max(0, options?.offsetBytes ?? 0), totalBytes);
  const maxBytes = Math.max(1, options?.maxBytes ?? 8 * 1024);
  const rawEndOffset = Math.min(totalBytes, offsetBytes + maxBytes);
  const endOffset = alignUtf8SliceEnd(targetBytes, offsetBytes, rawEndOffset);
  const sliceBytes = targetBytes.slice(offsetBytes, endOffset);
  const content = new TextDecoder().decode(sliceBytes);
  const hasMore = endOffset < totalBytes;

  return {
    artifactId,
    content,
    offsetBytes,
    readBytes: sliceBytes.byteLength,
    totalBytes,
    hasMore,
    ...(hasMore ? { nextOffsetBytes: endOffset } : {}),
    ...(options?.section ? { section: options.section } : {}),
  };
}
