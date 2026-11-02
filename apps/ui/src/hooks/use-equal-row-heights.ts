import * as React from 'react';

/**
 * Equalizes card heights within each visual row of a grid, while letting an
 * expanded card grow on its own. Cards opt in with `data-item-card` and report
 * `data-expanded`. The tallest collapsed card in a row sets a `min-height` on
 * every card in it.
 *
 * Not recomputed on expand/collapse (only on render and container width
 * change): measuring mid-animation made a just-collapsed card "sink".
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

      // Clear first to read natural heights, then group by row.
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
