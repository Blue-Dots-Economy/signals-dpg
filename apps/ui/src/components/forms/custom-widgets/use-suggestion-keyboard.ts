/**
 * Keyboard navigation for the autocomplete widgets' suggestion lists.
 *
 * Those lists were mouse-only: an input, and a list of clickable items with no
 * key handling, no roles and no active-option tracking. A keyboard user could
 * type a query, watch suggestions appear, and have no way to reach them —
 * arrow keys did nothing at all.
 *
 * One hook rather than three copies, because the three widgets (location,
 * multi-location, reference) differ only in what selecting does.
 *
 * The ARIA half is not decoration: `aria-activedescendant` is how a screen
 * reader announces the option the arrow keys moved to, and it only works when
 * the referenced element is a `role="option"` inside a `role="listbox"`. Wiring
 * the keys without it would look fixed for a sighted keyboard user while
 * staying silent for assistive tech, which is why the widgets' items changed
 * from `<button>` to `role="option"` at the same time.
 *
 * @module components/forms/custom-widgets/use-suggestion-keyboard
 */
import * as React from 'react';

interface UseSuggestionKeyboardArgs {
  /** How many suggestions are currently listed. */
  count: number;
  /** Whether the list is showing. */
  open: boolean;
  /** Reveal the list — ArrowDown/ArrowUp on a closed list with results. */
  onOpen: () => void;
  /** Dismiss the list — Escape, or Tab away. */
  onClose: () => void;
  /** Commit the suggestion at `index` — Enter. */
  onSelect: (index: number) => void;
  /** Stable prefix for the generated option ids; must be unique per field. */
  idPrefix: string;
}

interface UseSuggestionKeyboardResult {
  /** Index of the option the keyboard is on, or -1 for none. */
  activeIndex: number;
  /** Set by pointer hover so mouse and keyboard don't disagree about the highlight. */
  setActiveIndex: (index: number) => void;
  /** The DOM id for option `index`, for `aria-activedescendant` and the option itself. */
  optionId: (index: number) => string;
  /** The listbox's own id, for the input's `aria-controls`. */
  listboxId: string;
  /** Attach to the text input. */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function useSuggestionKeyboard({
  count,
  open,
  onOpen,
  onClose,
  onSelect,
  idPrefix,
}: UseSuggestionKeyboardArgs): UseSuggestionKeyboardResult {
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const listboxId = `${idPrefix}-listbox`;
  const optionId = React.useCallback((index: number) => `${idPrefix}-option-${index}`, [idPrefix]);

  // A new set of results, or a closed list, has no active option. Without this
  // the highlight would sit at a stale index — pointing at whichever suggestion
  // now happens to occupy that slot, so Enter would commit something the reader
  // never moved to.
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [count, open]);

  // Keep the highlighted option in view: the list scrolls (`max-h-60`), so
  // holding ArrowDown otherwise walks the highlight out of sight.
  React.useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, optionId]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (count === 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (!open) {
            onOpen();
            setActiveIndex(0);
            return;
          }
          // Clamped, not wrapped: a list that jumps back to the top when you
          // reach the bottom hides the fact that you have seen everything.
          setActiveIndex((i) => Math.min(i + 1, count - 1));
          return;

        case 'ArrowUp':
          event.preventDefault();
          if (!open) {
            onOpen();
            setActiveIndex(count - 1);
            return;
          }
          // From nothing, ArrowUp enters the list at its END, as every native
          // combobox does. Clamping from -1 would have entered at the start
          // instead, so ArrowDown and ArrowUp did the same thing.
          setActiveIndex((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
          return;

        case 'Home':
          if (!open) return;
          event.preventDefault();
          setActiveIndex(0);
          return;

        case 'End':
          if (!open) return;
          event.preventDefault();
          setActiveIndex(count - 1);
          return;

        case 'Enter':
          // Only swallowed when it actually commits a suggestion — otherwise
          // Enter must still reach the form and submit it.
          if (!open || activeIndex < 0) return;
          event.preventDefault();
          onSelect(activeIndex);
          return;

        case 'Escape':
          if (!open) return;
          event.preventDefault();
          onClose();
          setActiveIndex(-1);
          return;

        case 'Tab':
          // Not prevented: moving on should move on. The list just shouldn't
          // be left hanging over the next field.
          if (open) onClose();
          return;

        default:
          return;
      }
    },
    [count, open, activeIndex, onOpen, onClose, onSelect],
  );

  return { activeIndex, setActiveIndex, optionId, listboxId, onKeyDown };
}
