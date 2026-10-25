/** A box to place: its id and size in canvas pixels. */
export interface LayoutBox {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface LayeredLayoutInput {
  /** In a stable order; it seeds the order within each column. */
  readonly nodes: readonly LayoutBox[];
  /** Directed links (data and control); edges back into a cycle are ignored. */
  readonly edges: readonly { readonly source: string; readonly target: string }[];
  /** Pinned to the first column (e.g. the inputs card). */
  readonly first?: string;
  /** Pinned to its own last column (e.g. the outputs card). */
  readonly last?: string;
  readonly gapX?: number;
  readonly gapY?: number;
  /** Long flows wrap onto further rows to stay within this width, snaking: every other row runs right to left. */
  readonly maxRowWidth?: number;
  /** Space between wrapped rows; room for the lines that run back to the next row's start. */
  readonly rowGap?: number;
}

const SWEEPS = 8;

/**
 * Left-to-right layered layout: each card goes one column after everything it depends on;
 * cards within a column are ordered to cut crossing edges, then placed near the cards they
 * connect to without overlapping. Wider than `maxRowWidth`, the columns wrap onto rows of
 * about equal length that snake: the second row runs back from under the end of the first,
 * and so on. Returns top-left positions.
 */
export function layeredLayout(input: LayeredLayoutInput): Record<string, { x: number; y: number }> {
  const gapX = input.gapX ?? 120;
  const gapY = input.gapY ?? 48;
  const ids = input.nodes.map((n) => n.id);
  const box = new Map(input.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const into = new Map<string, string[]>(ids.map((id) => [id, []]));

  // Drop edges that close a cycle (found by DFS in input order), so layering terminates.
  const state = new Map<string, 'open' | 'done'>();
  const raw = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of input.edges) {
    if (e.source !== e.target && box.has(e.source) && box.has(e.target)) raw.get(e.source)!.push(e.target);
  }
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const next of raw.get(id)!) {
      if (state.get(next) === 'open') continue;
      if (!out.get(id)!.includes(next)) {
        out.get(id)!.push(next);
        into.get(next)!.push(id);
      }
      if (!state.has(next)) visit(next);
    }
    state.set(id, 'done');
  };
  for (const id of [...(input.first ? [input.first] : []), ...ids]) if (!state.has(id)) visit(id);

  // Longest path from the sources decides the column.
  const layer = new Map<string, number>();
  const pending = new Map(ids.map((id) => [id, into.get(id)!.length]));
  const queue = ids.filter((id) => pending.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const base = id === input.first ? 0 : Math.max(input.first && id !== input.first ? 1 : 0, ...into.get(id)!.map((p) => layer.get(p)! + 1));
    layer.set(id, base);
    for (const next of out.get(id)!) {
      pending.set(next, pending.get(next)! - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  }
  if (input.last && layer.has(input.last)) {
    const others = ids.filter((id) => id !== input.last).map((id) => layer.get(id) ?? 0);
    layer.set(input.last, Math.max(0, ...others) + 1);
  }

  const columns: string[][] = [];
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    (columns[l] ??= []).push(id);
  }
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];

  // Barycenter sweeps: order each column by the average position of its neighbours.
  const position = new Map<string, number>();
  const index = () => columns.forEach((col) => col.forEach((id, i) => position.set(id, i / Math.max(1, col.length - 1))));
  index();
  const reorder = (col: string[], neighbours: (id: string) => string[]) => {
    const key = new Map(
      col.map((id, i) => {
        const ns = neighbours(id).filter((n) => position.has(n));
        return [id, ns.length > 0 ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : i / Math.max(1, col.length - 1)];
      })
    );
    col.sort((a, b) => key.get(a)! - key.get(b)!);
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const col of order) {
      reorder(col, (id) => (down ? into.get(id)! : out.get(id)!));
      index();
    }
  }

  // x: column by column, each as wide as its widest card.
  const x: number[] = [];
  const columnWidth: number[] = [];
  let cursor = 0;
  for (const col of columns) {
    x.push(cursor);
    columnWidth.push(Math.max(0, ...col.map((id) => box.get(id)!.width)));
    cursor += columnWidth[columnWidth.length - 1]! + gapX;
  }

  // y: stack each column, pulled toward the cards it connects to, without overlaps.
  const centerY = new Map<string, number>();
  const place = (col: string[], neighbours: (id: string) => string[]) => {
    const desired = col.map((id) => {
      const ns = neighbours(id).filter((n) => centerY.has(n));
      return ns.length > 0 ? ns.reduce((s, n) => s + centerY.get(n)!, 0) / ns.length : 0;
    });
    const heights = col.map((id) => box.get(id)!.height);
    const total = heights.reduce((s, h) => s + h, 0) + gapY * Math.max(0, col.length - 1);
    // Start from a centred stack, then shift toward the desired centres in order.
    let top = -total / 2;
    const tops = heights.map((h) => {
      const t = top;
      top += h + gapY;
      return t;
    });
    const shift = desired.reduce((s, d, i) => s + (d - (tops[i]! + heights[i]! / 2)), 0) / Math.max(1, col.length);
    let floor = -Infinity;
    col.forEach((id, i) => {
      const want = Math.max(tops[i]! + shift, floor);
      centerY.set(id, want + heights[i]! / 2);
      floor = want + heights[i]! + gapY;
    });
  };
  columns.forEach((col) => place(col, (id) => into.get(id)!));
  // One pass back from the right so early columns line up with what they feed.
  for (const col of [...columns].reverse().slice(1)) {
    const fed = col.filter((id) => into.get(id)!.length === 0 && out.get(id)!.length > 0);
    if (fed.length === col.length) place(col, (id) => out.get(id)!);
  }

  // Rows: columns in order, split into rows of about equal length when one row is too wide;
  // odd rows are mirrored so each row continues from where the one above ends.
  const width = cursor - gapX;
  const rowCount = input.maxRowWidth && width > input.maxRowWidth ? Math.ceil(width / input.maxRowWidth) : 1;
  const perRow = Math.ceil(columns.length / rowCount);
  const lastOfFirstRow = Math.min(perRow, columns.length) - 1;
  const rowSpan = x[lastOfFirstRow]! + columnWidth[lastOfFirstRow]!;
  const result: Record<string, { x: number; y: number }> = {};
  let rowTop = 0;
  for (let first = 0; first < columns.length; first += perRow) {
    const reversed = (first / perRow) % 2 === 1;
    const row = columns.slice(first, first + perRow);
    const ids = row.flat();
    if (ids.length === 0) continue;
    const top = Math.min(...ids.map((id) => centerY.get(id)! - box.get(id)!.height / 2));
    const bottom = Math.max(...ids.map((id) => centerY.get(id)! + box.get(id)!.height / 2));
    // A single row keeps its centring around y = 0.
    const shift = rowCount === 1 ? 0 : rowTop - top;
    row.forEach((col, i) =>
      col.forEach((id) => {
        const left = x[first + i]! - x[first]!;
        result[id] = {
          x: Math.round(reversed ? rowSpan - left - columnWidth[first + i]! : left),
          y: Math.round(centerY.get(id)! - box.get(id)!.height / 2 + shift),
        };
      })
    );
    rowTop += bottom - top + (input.rowGap ?? 160);
  }
  return result;
}
