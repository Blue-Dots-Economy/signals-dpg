/**
 * Scroll-gating logic for the consent gate. Decisions live in the pure
 * {@link computeReadProgress} because happy-dom does no layout; the hook only
 * measures and delegates.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Slack when comparing scroll offsets, in CSS pixels. Fractional device pixel
 * ratios and iOS momentum overscroll both leave `scrollTop + clientHeight` a
 * pixel or so short of `scrollHeight`; exact equality would never fire.
 */
const TOLERANCE = 8;

/** Geometry of one document section within the scroll container. */
export interface SectionBox {
  id: string;
  top: number;
  height: number;
}

/** Geometry of the scroll container itself. */
export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** How much of the consent stack the reader has got through. */
export interface ReadProgress {
  readIds: string[];
  currentId: string | null;
  fillPercent: number;
  allRead: boolean;
}

/**
 * Decides which documents have been read, which is current, and how far the
 * tracker line extends. `sections` is in document order. Ids in `alreadyRead`
 * are never dropped, so scrolling back up cannot un-read a document.
 */
export function computeReadProgress(
  scroll: ScrollBox,
  sections: SectionBox[],
  alreadyRead: readonly string[],
): ReadProgress {
  if (sections.length === 0) {
    return { readIds: [], currentId: null, fillPercent: 100, allRead: true };
  }

  // An unlaid-out 0x0 container would pass the unscrollable test below and
  // mark everything read unseen.
  if (scroll.clientHeight === 0 || scroll.scrollHeight === 0) {
    const readIds = sections.filter((s) => alreadyRead.includes(s.id)).map((s) => s.id);
    return {
      readIds,
      currentId: sections.find((s) => !readIds.includes(s.id))?.id ?? null,
      fillPercent: 0,
      allRead: false,
    };
  }

  const viewBottom = scroll.scrollTop + scroll.clientHeight;
  // Content that cannot scroll is already shown in full; without this a
  // document shorter than the viewport could never be marked read.
  const unscrollable =
    scroll.clientHeight > 0 && scroll.scrollHeight <= scroll.clientHeight + TOLERANCE;

  const read = new Set(alreadyRead);
  for (const s of sections) {
    if (unscrollable || viewBottom >= s.top + s.height - TOLERANCE) read.add(s.id);
  }

  let currentId: string | null = null;
  let fractionOfCurrent = 0;
  for (const s of sections) {
    if (read.has(s.id)) continue;
    currentId = s.id;
    fractionOfCurrent = Math.min(1, Math.max(0, (viewBottom - s.top) / Math.max(1, s.height)));
    break;
  }

  const readIds = sections.filter((s) => read.has(s.id)).map((s) => s.id);
  // The fill spans the N-1 gaps between the N tracker dots, mirroring
  // aggregator-dpg's read-progress.ts. With exactly two documents (the
  // Signals gate: privacy + terms) that one gap would read 100% as soon as
  // the first finishes, so two documents use N segments instead; three or
  // more keep the gap model for parity with the aggregator.
  const segments = sections.length === 2 ? sections.length : Math.max(1, sections.length - 1);
  const fillPercent = Math.min(100, ((readIds.length + fractionOfCurrent) / segments) * 100);

  return { readIds, currentId, fillPercent, allRead: readIds.length === sections.length };
}

/**
 * Progress before the first measurement: nothing read, unless `docIds` is
 * empty. Not `computeReadProgress` with no sections, which reports
 * `allRead: true`; an unmeasured gate must not render its checkbox enabled,
 * even for the frame before the effect measures.
 */
export function initialProgress(docIds: readonly string[]): ReadProgress {
  return {
    readIds: [],
    currentId: docIds[0] ?? null,
    fillPercent: 0,
    allRead: docIds.length === 0,
  };
}

/**
 * Tracks read progress for a scroll container holding `docIds` in order.
 * Re-measures on scroll and resize, since font swaps, async Markdown and
 * orientation changes move the geometry after first paint.
 */
export function useReadProgress(
  scrollRef: RefObject<HTMLElement | null>,
  docIds: string[],
): ReadProgress {
  const readRef = useRef<string[]>([]);
  const [progress, setProgress] = useState<ReadProgress>(() => initialProgress(docIds));

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // getBoundingClientRect deltas, not offsetTop: offsetTop is relative to
    // the nearest positioned ancestor, which may not be the scroller, and
    // mixing it with `scrollTop + clientHeight` can make the last section
    // unreachable. Rect deltas land in the scroller's content space.
    const readerRect = el.getBoundingClientRect();
    const sections: SectionBox[] = [];
    for (const id of docIds) {
      const node = el.querySelector<HTMLElement>(`[data-consent-section="${id}"]`);
      if (node) {
        const nodeRect = node.getBoundingClientRect();
        const top = nodeRect.top - readerRect.top + el.scrollTop;
        sections.push({ id, top, height: nodeRect.height });
      }
    }
    const next = computeReadProgress(
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
      sections,
      readRef.current,
    );
    // Union, not replace: a transiently missing section node would otherwise
    // drop its id and the tracker would go backwards.
    readRef.current = Array.from(new Set([...readRef.current, ...next.readIds]));
    setProgress(next);
  }, [scrollRef, docIds]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [scrollRef, measure]);

  return progress;
}
