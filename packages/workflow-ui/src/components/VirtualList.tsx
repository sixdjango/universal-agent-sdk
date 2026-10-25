import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useRef } from 'react';

/** Lists shorter than this render every row: nothing to save, and they render on the server. */
const VIRTUALIZE_FROM = 40;

/**
 * A scrolling list that renders only the rows in view once it is long (rows are measured as
 * they render, so they may differ in height). The element is its own scroll container, so its
 * class must bound its height. With `follow` it keeps the newest row in view as rows arrive,
 * unless the reader has scrolled up.
 */
export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  className,
  estimateSize,
  gap = 0,
  follow = false,
  virtualize = true,
  ...rest
}: {
  readonly items: readonly T[];
  itemKey(item: T, index: number): string;
  renderItem(item: T, index: number): ReactNode;
  readonly className?: string;
  /** Rough row height before a row is measured, in px. */
  readonly estimateSize: number;
  /** Space below every row but the last, in px. */
  readonly gap?: number;
  readonly follow?: boolean;
  /** False for lists in a box that does not scroll by itself. */
  readonly virtualize?: boolean;
  readonly role?: string;
  readonly 'aria-label'?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const virtual = virtualize && items.length >= VIRTUALIZE_FROM;
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize + gap,
    getItemKey: (index) => itemKey(items[index]!, index),
    overscan: 8,
    // While the reader is at the end, new rows and rows growing as they are measured keep it there.
    ...(follow ? { anchorTo: 'end' as const, followOnAppend: true, scrollEndThreshold: 24 } : {}),
  });

  // A followed list opens at its newest row (and stays there when it becomes long enough to
  // virtualize); short lists are kept at the end here.
  const last = items[items.length - 1];
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!follow || !followRef.current || !scroller || items.length === 0) return;
    if (virtual) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    else scroller.scrollTop = scroller.scrollHeight;
  }, [follow, virtual, virtualizer, virtual ? 0 : items.length, virtual ? undefined : last]);

  const row = (item: T, index: number) => (index < items.length - 1 && gap ? { paddingBottom: gap } : undefined);
  return (
    <div
      ref={scrollRef}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      {...rest}
    >
      {virtual ? (
        <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)`, ...row(items[v.index]!, v.index) }}
            >
              {renderItem(items[v.index]!, v.index)}
            </div>
          ))}
        </div>
      ) : (
        items.map((item, index) => (
          <div key={itemKey(item, index)} style={row(item, index)}>
            {renderItem(item, index)}
          </div>
        ))
      )}
    </div>
  );
}
