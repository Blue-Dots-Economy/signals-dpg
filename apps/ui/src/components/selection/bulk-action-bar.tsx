import * as React from 'react';
import { useTranslation } from 'react-i18next';

interface BulkActionBarProps {
  count: number;
  onClear: () => void;
  /** Action buttons (Connect / Accept+Reject / Cancel). */
  children: React.ReactNode;
  /** Optional secondary text after the count, e.g. "3 sent · 2 received". */
  detail?: string;
}

export function BulkActionBar({ count, onClear, children, detail }: BulkActionBarProps) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div className="sticky bottom-4 z-[1100] mt-4 flex items-center justify-between gap-3 rounded-2xl bg-foreground px-4 py-3 text-background shadow-lg">
      <span className="text-sm font-semibold">
        {t('selection.n_selected', { count })}
        {detail && <span className="ml-2 font-normal text-background/70">({detail})</span>}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-background/30 px-3 py-1.5 text-xs font-semibold text-background/80 transition hover:text-background"
        >
          {t('selection.clear')}
        </button>
        {children}
      </div>
    </div>
  );
}
