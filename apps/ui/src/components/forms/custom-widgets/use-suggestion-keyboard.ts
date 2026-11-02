/**
 * Keyboard navigation for the location, multi-location and reference
 * autocomplete suggestion lists.
 *
 * `aria-activedescendant` is how a screen reader announces the option the
 * arrow keys moved to, and it only works when the referenced element is a
 * `role="option"` inside a `role="listbox"`, so the widgets' items use those
 * roles.
 */
import * as React from 'react';

interface UseSuggestionKeyboardArgs {
  /**
   * The suggestions in display order. Must be referentially stable: a new
   * identity resets the highlight.
   */
  items: readonly unknown[];
  open: boolean;
  /** ArrowDown/ArrowUp on a closed list with results. */
  onOpen: () => void;
  /** Escape, or Tab away. */
  onClose: () => void;
  /** Enter on the active suggestion. */
  onSelect: (index: number) => void;
  /** Stable prefix for the generated option ids; must be unique per field. */
  idPrefix: string;
}

interface UseSuggestionKeyboardResult {
  /** Index of the option the keyboard is on, or -1 for none. */
  activeIndex: number;
  /** Set by pointer hover so mouse and keyboard don't disagree about the highlight. */
  setActiveIndex: (index: number) => void;
  optionId: (index: number) => string;
  /**
   * For the input's `aria-activedescendant`. Undefined while the list is
   * closed, because the closed list is unmounted.
   */
  activeDescendantId: string | undefined;
  /** The listbox's own id, for the input's `aria-controls`. */
  listboxId: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function useSuggestionKeyboard({
  items,
  open,
  onOpen,
  onClose,
  onSelect,
  idPrefix,
}: UseSuggestionKeyboardArgs): UseSuggestionKeyboardResult {
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const count = items.length;

  const listboxId = `${idPrefix}-listbox`;
  const optionId = React.useCallback((index: number) => `${idPrefix}-option-${index}`, [idPrefix]);

  // A new result set has no active option. Keyed on `items`, not `count` (a
  // same-size replacement would keep a stale index, so Enter would commit an
  // unseen option) and not `open` (opening via ArrowDown sets the index in the
  // same commit, which an `open` dependency would wipe).
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Keep the highlighted option in view in the scrolling list.
  React.useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, optionId]);

  // On a closed list, either arrow opens it at the near end, like a native
  // combobox.
  const handleClosedKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      onOpen();
      setActiveIndex(event.key === 'ArrowDown' ? 0 : count - 1);
    },
    [count, onOpen],
  );

  const handleOpenKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          // Clamped, not wrapped, so the user can tell they reached the end.
          setActiveIndex((i) => Math.min(i + 1, count - 1));
          return;

        case 'ArrowUp':
          event.preventDefault();
          // From nothing, ArrowUp enters at the end.
          setActiveIndex((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
          return;

        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          return;

        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          return;

        case 'Enter':
          // Swallowed only when it commits a suggestion; otherwise Enter must
          // still submit the form.
          if (activeIndex < 0) return;
          event.preventDefault();
          onSelect(activeIndex);
          return;

        case 'Escape':
          event.preventDefault();
          onClose();
          setActiveIndex(-1);
          return;

        case 'Tab':
          // Not prevented; just closes the list so it does not cover the next
          // field.
          onClose();
          return;

        default:
          return;
      }
    },
    [count, activeIndex, onClose, onSelect],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (count === 0) return;
      if (open) handleOpenKey(event);
      else handleClosedKey(event);
    },
    [count, open, handleOpenKey, handleClosedKey],
  );

  return {
    activeIndex,
    setActiveIndex,
    optionId,
    activeDescendantId: open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
    listboxId,
    onKeyDown,
  };
}
