import * as React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type ChipKind = 'domain' | 'facet' | 'search' | 'sort' | 'area';

export interface AppliedChip {
  kind: ChipKind;
  /** Stable identity for the React key and the caller's removal switch. */
  id: string;
  /** Already-localized display text — this component does no formatting. */
  label: string;
  /**
   * False for a constraint that cannot be dropped — the domain chip, since the
   * list always needs exactly one domain to fetch.
   */
  removable: boolean;
}

export interface AppliedFilterChipsProps {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
}

const KIND_STYLES: Record<ChipKind, string> = {
  domain: 'bg-primary text-primary-foreground border-primary',
  facet: 'bg-accent text-accent-foreground border-border',
  // Dashed: this chip is edited in the app-bar search box, only removed here.
  search: 'bg-accent text-accent-foreground border-border border-dashed',
  sort: 'bg-muted text-muted-foreground border-border',
  area: 'bg-accent text-accent-foreground border-border',
};

/**
 * The applied-filter read-out. It formats nothing, owns no filter state, and
 * reports removals to the caller. Clear-all lives in the toolbar, not here.
 *
 * Design: docs/architecture/ui-components-browse-controls.md
 */
export function AppliedFilterChips({
  chips,
  onRemove,
}: Readonly<AppliedFilterChipsProps>) {
  const { t } = useTranslation();
  const groupRef = React.useRef<HTMLFieldSetElement>(null);
  const pendingFocus = React.useRef(false);

  // Focus returns to the group after a removal: the activated button unmounts
  // with its chip, so focus would otherwise fall to <body>. Gated on
  // `pendingFocus` so an unrelated `chips` change does not steal focus.
  React.useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    groupRef.current?.focus();
  }, [chips]);

  if (chips.length === 0) return null;

  return (
    // <fieldset> for the native implicit group role (Sonar S6819).
    <fieldset
      ref={groupRef}
      tabIndex={-1}
      aria-label={t('browse.applied_filters')}
      className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 outline-none"
    >
      {chips.map((chip) => (
        <span
          key={`${chip.kind}:${chip.id}`}
          data-testid="applied-chip"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
            'pointer-coarse:min-h-11',
            KIND_STYLES[chip.kind],
          )}
        >
          {chip.label}
          {chip.removable && (
            <button
              type="button"
              aria-label={t('browse.remove_filter', { label: chip.label })}
              onClick={() => {
                pendingFocus.current = true;
                onRemove(chip);
              }}
              className="rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
    </fieldset>
  );
}
