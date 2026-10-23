import * as React from 'react';

export interface CardSelection {
  selectMode: boolean;
  enterSelect: () => void;
  /** Turns select mode off and clears the selection and lock. */
  exitSelect: () => void;
  selected: Set<string>;
  isSelected: (id: string) => boolean;
  /**
   * Toggles an id. `groupKey` is its lock group (e.g. domain or status). The
   * first toggle into an empty selection sets the lock; ids from another group
   * are then ignored.
   */
  toggle: (id: string, groupKey?: string) => void;
  /** Whether an id in `groupKey` may be selected under the current lock. */
  canSelect: (groupKey?: string) => boolean;
  /** Empties the selection and releases the lock, staying in select mode. */
  clear: () => void;
  /** The group key the batch is locked to, or null when nothing is selected. */
  lockKey: string | null;
  /** Replaces the selection; `groupKey` locks it to that group (e.g. select-all). */
  setSelected: (ids: string[], groupKey?: string) => void;
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
        if (lockKey !== null && groupKey !== undefined && groupKey !== lockKey) {
          return prev;
        }
        next.add(id);
        if (prev.size === 0 && groupKey !== undefined) setLockKey(groupKey);
        return next;
      });
    },
    [lockKey],
  );

  const setSelected = React.useCallback((ids: string[], groupKey?: string) => {
    setSelectedState(new Set(ids));
    if (ids.length === 0) setLockKey(null);
    else if (groupKey !== undefined) setLockKey(groupKey);
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
