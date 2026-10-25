import { describe, expect, it } from 'vitest';
import { layeredLayout } from '../src/model/layout';

const box = (id: string, height = 100, width = 200) => ({ id, width, height });
const overlaps = (pos: Record<string, { x: number; y: number }>, boxes: ReturnType<typeof box>[]) =>
  boxes.some((a, i) =>
    boxes.slice(i + 1).some((b) => {
      const pa = pos[a.id]!;
      const pb = pos[b.id]!;
      return pa.x < pb.x + b.width && pb.x < pa.x + a.width && pa.y < pb.y + b.height && pb.y < pa.y + a.height;
    })
  );

describe('layered layout', () => {
  it('puts each card after what it depends on, inputs first and outputs last, with no overlaps', () => {
    const boxes = [box('$input', 80), box('a', 300), box('b', 120), box('c', 260), box('d'), box('$output', 80)];
    const pos = layeredLayout({
      nodes: boxes,
      edges: [
        { source: '$input', target: 'a' },
        { source: '$input', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'c' },
        { source: 'c', target: '$output' },
        { source: 'd', target: '$output' },
      ],
      first: '$input',
      last: '$output',
    });
    expect(pos.$input!.x).toBe(0);
    expect(pos.a!.x).toBeGreaterThan(pos.$input!.x);
    expect(pos.a!.x).toBe(pos.b!.x);
    expect(pos.c!.x).toBeGreaterThan(pos.a!.x);
    // An unconnected-from-input card still sits after the inputs column.
    expect(pos.d!.x).toBe(pos.a!.x);
    expect(pos.$output!.x).toBeGreaterThan(pos.c!.x);
    expect(overlaps(pos, boxes)).toBe(false);
  });

  it('wraps a long flow onto rows of about equal length that snake back and forth', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const boxes = ids.map((id) => box(id, 100 + (id === 's3' ? 80 : 0)));
    const edges = ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
    const single = layeredLayout({ nodes: boxes, edges });
    // Without a width limit it stays one row, cards centred on one line.
    expect(new Set(ids.map((id) => single[id]!.y + boxes.find((b) => b.id === id)!.height / 2)).size).toBe(1);

    // 12 columns of 200 + 120 gaps = 3720 wide: three rows of four, the middle one running back.
    const pos = layeredLayout({ nodes: boxes, edges, maxRowWidth: 1400, rowGap: 160 });
    const rows = [ids.slice(0, 4), ids.slice(4, 8), ids.slice(8)];
    expect(rows.map((row) => row.map((id) => pos[id]!.x))).toEqual([
      [0, 320, 640, 960],
      [960, 640, 320, 0],
      [0, 320, 640, 960],
    ]);
    const rowTop = (row: string[]) => Math.min(...row.map((id) => pos[id]!.y));
    const rowBottom = (row: string[]) => Math.max(...row.map((id) => pos[id]!.y + boxes.find((b) => b.id === id)!.height));
    expect(rowTop(rows[1]!) - rowBottom(rows[0]!)).toBe(160);
    expect(rowTop(rows[2]!) - rowBottom(rows[1]!)).toBe(160);
    expect(overlaps(pos, boxes)).toBe(false);
  });

  it('orders a column to avoid crossing lines', () => {
    // top/bottom on the left feed bottom'/top' on the right; the right column should flip.
    const boxes = [box('top'), box('bottom'), box('x'), box('y')];
    const pos = layeredLayout({
      nodes: boxes,
      edges: [
        { source: 'top', target: 'y' },
        { source: 'bottom', target: 'x' },
      ],
    });
    expect(pos.top!.y).toBeLessThan(pos.bottom!.y);
    expect(pos.y!.y).toBeLessThan(pos.x!.y);
  });

  it('survives cycles', () => {
    const boxes = [box('a'), box('b'), box('c')];
    const pos = layeredLayout({
      nodes: boxes,
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'a' },
      ],
    });
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c']);
    expect(pos.a!.x).toBeLessThan(pos.b!.x);
    expect(pos.b!.x).toBeLessThan(pos.c!.x);
  });
});
