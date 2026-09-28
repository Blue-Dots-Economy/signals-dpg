import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type SheetSnap = 'peek' | 'half' | 'full';

const SNAP_ORDER: SheetSnap[] = ['full', 'half', 'peek'];

/** Pointer travel (px) before a press on the header becomes a drag. */
const DRAG_THRESHOLD_PX = 6;
/** Release speed (px/ms) above which the sheet moves one snap in that direction. */
const FLICK_VELOCITY = 0.5;
/** Fallback peek height before the header has been measured. */
const DEFAULT_PEEK_PX = 88;

/**
 * Snap positions as a downward offset (px) from fully open, for a sheet of
 * `height` px whose always-visible header is `peekPx` tall.
 */
export function snapOffsets(height: number, peekPx: number): Record<SheetSnap, number> {
  return { full: 0, half: Math.round(height * 0.5), peek: Math.max(0, height - peekPx) };
}

/**
 * Where a drag released at `offset` should settle. A flick moves one snap in
 * its direction from `from`; a slow release goes to the nearest snap.
 */
export function resolveSnap(opts: {
  offset: number;
  velocity: number;
  from: SheetSnap;
  offsets: Record<SheetSnap, number>;
}): SheetSnap {
  const { offset, velocity, from, offsets } = opts;
  if (Math.abs(velocity) > FLICK_VELOCITY) {
    const i = SNAP_ORDER.indexOf(from);
    // Positive velocity = moving down = towards peek (higher index).
    const next = velocity > 0 ? Math.min(i + 1, SNAP_ORDER.length - 1) : Math.max(i - 1, 0);
    return SNAP_ORDER[next];
  }
  let best: SheetSnap = from;
  let bestDistance = Infinity;
  for (const snap of SNAP_ORDER) {
    const distance = Math.abs(offsets[snap] - offset);
    if (distance < bestDistance) {
      best = snap;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ResultsSheetProps {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** Always-visible row under the handle — at peek, this is all that shows. */
  header: React.ReactNode;
  /** The scrolling body: the results list. */
  children: React.ReactNode;
}

interface DragState {
  pointerId: number;
  startY: number;
  startTime: number;
  base: number;
  offsets: Record<SheetSnap, number>;
  dragging: boolean;
}

/**
 * The phone discovery layout's results bottom sheet (#745, per the GZB
 * prototype): three snap points over a full-screen map — peek (handle + header
 * only), half, and full (up to the domain chip row).
 *
 * Deliberately NOT a vaul `Drawer`. vaul wraps Radix Dialog, which stays modal
 * even with `modal={false}`: it traps focus and marks everything outside the
 * sheet `aria-hidden` — including the search box and the chips, which have to
 * stay usable while the sheet is open (the prototype has exactly that bug).
 * This is a plain labelled region positioned by a CSS transform.
 *
 * It is `absolute` inside its (relative) container rather than `fixed`, so
 * "full" ends at the container's top edge — under the chip row at whatever
 * height the chrome above happens to be.
 *
 * Only the handle + header area drags; the body scrolls natively.
 */
export function ResultsSheet({ snap, onSnapChange, header, children }: Readonly<ResultsSheetProps>) {
  const { t } = useTranslation();
  const sheetRef = React.useRef<HTMLElement>(null);
  const headerRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const [dragOffset, setDragOffset] = React.useState<number | null>(null);
  const [peekPx, setPeekPx] = React.useState(DEFAULT_PEEK_PX);

  // The peek shows exactly the handle + header, whatever height they wrap to.
  React.useLayoutEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const measure = () => {
      if (node.offsetHeight > 0) setPeekPx(node.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const height = sheetRef.current?.offsetHeight ?? 0;
    if (height === 0) return;
    const offsets = snapOffsets(height, peekPx);
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startTime: performance.now(),
      base: offsets[snap],
      offsets,
      dragging: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      // Capture only once it IS a drag: capturing on press would retarget
      // the click away from the toggle / Filters buttons in the header.
      drag.dragging = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const max = drag.offsets.peek;
    setDragOffset(Math.min(Math.max(drag.base + dy, 0), max));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!drag.dragging) return;
    const dy = e.clientY - drag.startY;
    const elapsed = Math.max(performance.now() - drag.startTime, 1);
    const offset = Math.min(Math.max(drag.base + dy, 0), drag.offsets.peek);
    setDragOffset(null);
    const next = resolveSnap({ offset, velocity: dy / elapsed, from: snap, offsets: drag.offsets });
    if (next !== snap) onSnapChange(next);
  };

  const transform = (() => {
    if (dragOffset !== null) return `translateY(${dragOffset}px)`;
    if (snap === 'full') return 'translateY(0)';
    if (snap === 'half') return 'translateY(50%)';
    return `translateY(calc(100% - ${peekPx}px))`;
  })();

  const expanded = snap !== 'peek';

  return (
    <section
      ref={sheetRef}
      aria-label={t('discover.results')}
      data-testid="results-sheet"
      data-snap={snap}
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 flex h-full flex-col rounded-t-2xl border-t border-border bg-background shadow-[0_-8px_30px_rgba(0,0,0,0.18)]',
        dragOffset === null && 'transition-transform duration-300 ease-out',
      )}
      style={{ transform }}
    >
      <div
        ref={headerRef}
        data-testid="results-sheet-drag-area"
        className="flex-none touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'discover.collapse_results' : 'discover.expand_results')}
          onClick={() => onSnapChange(expanded ? 'peek' : 'full')}
          className="mx-auto flex h-6 w-16 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden="true" className="h-1.5 w-12 rounded-full bg-muted-foreground/40" />
        </button>
        {header}
      </div>
      {/* `inert` at peek: the list is off screen there, so Tab must not walk
          into it. */}
      <div
        data-testid="results-sheet-body"
        inert={!expanded}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
      >
        {children}
      </div>
    </section>
  );
}
