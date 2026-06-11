import * as React from 'react';

/**
 * Equalizes the height of cards within each visual row of a grid so collapsed
 * cards line up, while letting an expanded card grow on its own.
 *
 * Cards opt in with `data-item-card` on their root and `data-expanded`
 * reflecting their state. For each row (grouped by vertical position) we measure
 * the tallest **collapsed** card and apply that as a `min-height` to every card
 * in the row. Because it is a `min-height` (not `height`):
 *   - a collapsed card is padded up to the row height (cards line up);
 *   - an expanded card simply grows past it (its neighbours are untouched);
 *   - collapsing a card snaps it straight back to the stored min-height.
 *
 * Crucially we do NOT recompute on expand/collapse — only on mount, re-render
 * (items change), and container width change. Recomputing mid-toggle measured a
 * still-animating height and made the just-collapsed card "sink"; keeping the
 * min-height stable avoids that entirely.
 */
export function useEqualRowHeights<
  T extends HTMLElement = HTMLDivElement,
>(): React.RefObject<T | null> {
  const ref = React.useRef<T>(null);

  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;

    const equalize = () => {
      const cards = Array.from(
        container.querySelectorAll<HTMLElement>('[data-item-card]')
      );
      if (cards.length === 0) return;

      // Clear first so we read each card's natural height, then group by row.
      for (const card of cards) card.style.minHeight = '';

      const containerTop = container.getBoundingClientRect().top;
      const rows = new Map<number, HTMLElement[]>();
      for (const card of cards) {
        const top = Math.round(card.getBoundingClientRect().top - containerTop);
        const bucket = rows.get(top);
        if (bucket) bucket.push(card);
        else rows.set(top, [card]);
      }

      for (const bucket of rows.values()) {
        const collapsed = bucket.filter(
          (card) => card.dataset.expanded !== 'true'
        );
        // Height a row settles to is driven by its collapsed cards; an expanded
        // card is free to exceed it.
        const basis = collapsed.length > 0 ? collapsed : bucket;
        const max = Math.max(...basis.map((card) => card.offsetHeight));
        for (const card of bucket) card.style.minHeight = `${max}px`;
      }
    };

    equalize();

    let prevWidth = container.offsetWidth;
    const resizeObserver = new ResizeObserver(() => {
      const width = container.offsetWidth;
      if (width !== prevWidth) {
        prevWidth = width;
        equalize();
      }
    });
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  });

  return ref;
}
