import { type ReactNode, useEffect, useRef } from 'react';

/** Anchored dropdown that closes on outside click or Escape. */
export function Menu(props: {
  open: boolean;
  onClose(): void;
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(event.target as globalThis.Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && props.onClose();
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  return (
    <div
      ref={ref}
      className="menu"
      style={{
        ...(props.placement === 'above' ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
        [props.align === 'right' ? 'right' : 'left']: 0,
        width: props.width ?? 280,
      }}
    >
      {props.children}
    </div>
  );
}
