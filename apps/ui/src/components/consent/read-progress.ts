/**
 * Scroll-gating logic for the consent gate.
 *
 * All decisions live in {@link computeReadProgress}, a pure function over plain
 * numbers. jsdom performs no layout — every offset and scroll property reads 0
 * — so testing this through the DOM would mean stubbing geometry on every
 * element. Keeping the logic pure makes it directly testable; the hook only
 * measures and delegates.
 *
 * @module apps/ui/src/components/consent/read-progress
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
 * Decides which documents have been read, which is in hand, and how far the
 * tracker's line should extend.
 *
 * @param scroll - Scroll container geometry.
 * @param sections - Section geometry, in document order.
 * @param alreadyRead - Ids already read; never dropped, so scrolling back up
 *   cannot un-read a document.
 * @returns Progress across the whole stack.
 */
export function computeReadProgress(
  scroll: ScrollBox,
  sections: SectionBox[],
  alreadyRead: readonly string[],
): ReadProgress {
  if (sections.length === 0) {
    return { readIds: [], currentId: null, fillPercent: 100, allRead: true };
  }

  // A container that has not been laid out yet is 0x0, which would otherwise
  // satisfy the unscrollable test below and mark every document read before
  // the reader has seen anything. Unmeasured is not evidence of anything.
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
  // Content that cannot scroll has, by definition, already been shown in full.
  // Without this a document shorter than the viewport — the 111-character
  // profile statement — would never be markable as read and would lock the
  // form permanently on every network.
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
  const segments = Math.max(1, sections.length - 1);
  const fillPercent = Math.min(100, ((readIds.length + fractionOfCurrent) / segments) * 100);

  return { readIds, currentId, fillPercent, allRead: readIds.length === sections.length };
}

/**
 * Tracks read progress for a scroll container holding `docIds` in order.
 *
 * Re-measures on scroll and on resize: a web-font swap, async Markdown render,
 * or orientation change all move the geometry after first paint.
 *
 * @param scrollRef - Ref to the scrolling element.
 * @param docIds - Ids of the documents rendered inside it, in order.
 * @returns Current progress.
 */
export function useReadProgress(
  scrollRef: RefObject<HTMLElement | null>,
  docIds: string[],
): ReadProgress {
  const readRef = useRef<string[]>([]);
  const [progress, setProgress] = useState<ReadProgress>(() =>
    computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, [], []),
  );

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sections: SectionBox[] = [];
    for (const id of docIds) {
      const node = el.querySelector<HTMLElement>(`[data-consent-section="${id}"]`);
      if (node) sections.push({ id, top: node.offsetTop, height: node.offsetHeight });
    }
    const next = computeReadProgress(
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
      sections,
      readRef.current,
    );
    readRef.current = next.readIds;
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
