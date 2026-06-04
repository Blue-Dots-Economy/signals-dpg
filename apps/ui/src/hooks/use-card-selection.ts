import * as React from 'react';

export interface CardSelection {
  /** Whether select mode is active. */
  selectMode: boolean;
  /** Turn select mode on. */
  enterSelect: () => void;
  /** Turn select mode off AND clear selection + lock. */
  exitSelect: () => void;
  /** Currently selected item ids. */
  selected: Set<string>;
  /** True when this id is selected. */
  isSelected: (id: string) => boolean;
  /**
   * Toggle an id. `groupKey` is the lock group the id belongs to (e.g. its
   * domain, or its status). The first toggle in an empty selection sets the
   * lock; while a lock is set, toggling an id from a different group is ignored.
   */
  toggle: (id: string, groupKey?: string) => void;
  /** Returns true when an id may be selected given the current lock. */
  canSelect: (groupKey?: string) => boolean;
  /** Empty the selection (and release the lock) but stay in select mode. */
  clear: () => void;
  /** The group key the batch is locked to, or null when nothing is selected. */
  lockKey: string | null;
  /** Replace the selection with the given ids (used to keep failed ids selected). */
  setSelected: (ids: string[]) => void;
}

export function useCardSelection(): CardSelection {
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelectedState] = React.useState<Set<string>>(new Set());
  const [lockKey, setLockKey] = React.useState<string | null>(null);

  const enterSelect = React.useCallback(() => setSelectMode(true), []);

  const clear = React.useCallback(() => {
    setSelectedState(new Set());
    setLockKey(null);
  }, []);

  const exitSelect = React.useCallback(() => {
    setSelectMode(false);
    setSelectedState(new Set());
    setLockKey(null);
  }, []);

  const canSelect = React.useCallback(
    (groupKey?: string) => lockKey === null || groupKey === undefined || groupKey === lockKey,
    [lockKey],
  );

  const toggle = React.useCallback(
    (id: string, groupKey?: string) => {
      setSelectedState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          if (next.size === 0) setLockKey(null);
          return next;
        }
        // Adding: enforce lock.
        if (lockKey !== null && groupKey !== undefined && groupKey !== lockKey) {
          return prev; // ignore off-lock additions
        }
        next.add(id);
        if (prev.size === 0 && groupKey !== undefined) setLockKey(groupKey);
        return next;
      });
    },
    [lockKey],
  );

  const setSelected = React.useCallback((ids: string[]) => {
    setSelectedState(new Set(ids));
    if (ids.length === 0) setLockKey(null);
  }, []);

  const isSelected = React.useCallback((id: string) => selected.has(id), [selected]);

  return {
    selectMode,
    enterSelect,
    exitSelect,
    selected,
    isSelected,
    toggle,
    canSelect,
    clear,
    lockKey,
    setSelected,
  };
}
