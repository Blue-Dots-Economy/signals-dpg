/**
 * Scroll-gating logic for the consent gate.
 *
 * All decisions live in {@link computeReadProgress}, a pure function over plain
 * numbers. This repo's Vitest environment is happy-dom, which — like jsdom —
 * performs no real layout: every offset and scroll property reads 0 unless a
 * test stubs it — so testing this through the DOM would mean stubbing
 * geometry on every element. Keeping the logic pure makes it directly
 * testable; the hook only measures and delegates.
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
 * Bootstrap progress, before the first measurement has run.
 *
 * Deliberately NOT `computeReadProgress({...0x0...}, [], [])`: an empty
 * `sections` array hits the pure function's empty-document-list branch,
 * which reports `allRead: true` so a genuinely empty list cannot block
 * forever. Here "no sections yet" means "not measured", the opposite — and
 * an unmeasured gate must never render its checkbox enabled. `useEffect`
 * runs after paint, so a wrong `true` here is briefly visible in a real
 * browser before `measure()` ever runs.
 *
 * @param docIds - Ids of the documents the gate is about to render, in order.
 * @returns Nothing-read progress, except for a genuinely empty `docIds` list.
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
  const [progress, setProgress] = useState<ReadProgress>(() => initialProgress(docIds));

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Section geometry via getBoundingClientRect, NOT offsetTop/offsetHeight.
    // offsetTop is relative to the nearest *positioned* ancestor, which for
    // this reader is the dialog/drawer's own `fixed` wrapper -- not the
    // scroller -- because the reader itself has no `position`. That mixed
    // offsetTop (dialog-relative) with `scrollTop + clientHeight` (scroller-
    // content-relative): two different coordinate systems offset by a
    // constant (the reader's distance from the dialog's top edge), so the
    // last section's read check could never be satisfied — the gate was
    // permanently unreachable in every real browser while every unit test,
    // whose stubs set offsetTop directly, stayed green. A getBoundingClientRect
    // delta is computed relative to the scroller's own rect, so it lands in
    // the scroller's content space regardless of which ancestor happens to
    // be positioned.
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
    // Union, don't replace: computeReadProgress only re-emits an id whose
    // section was found in *this* call's `sections`. A transiently missing
    // DOM node (remount, conditional render, a measurement racing layout)
    // would otherwise silently drop that id from the bookkeeping and the
    // tracker would go backwards. Stickiness is the whole guarantee.
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
