import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { DomainOption } from '@/components/filters/domain-control';

export interface DomainChipRowProps {
  options: DomainOption[];
  /** Domain ids currently selected. An `All` chip is pressed when this is empty. */
  selected: string[];
  /**
   * Offer the `All` chip. The map can show every domain at once; the list is
   * single-domain (#644), so the phone layout passes this only while the
   * results sheet is at its map (peek) position.
   */
  showAll: boolean;
  /** `null` = All. */
  onSelect: (domainId: string | null) => void;
}

/**
 * The phone discovery layout's domain selector (#745, per the GZB prototype):
 * one row of pill chips under the top bar, single-select, scrolling sideways
 * rather than wrapping so it stays one row on a narrow screen.
 *
 * Single-select even on the map, unlike the desktop `DomainControl`'s
 * multi-select there — the prototype's chips replace each other, and a tap
 * target per domain is simpler on a phone than toggling a subset. A subset
 * that arrives from a desktop URL (`?map_domains=a,b`) still renders as each
 * of its chips pressed; the next tap collapses it to one.
 */
export function DomainChipRow({ options, selected, showAll, onSelect }: Readonly<DomainChipRowProps>) {
  const { t } = useTranslation();

  // One browsable domain: nothing to choose, and an `All` beside it would be
  // the same thing twice.
  if (options.length <= 1) return null;

  const allOn = selected.length === 0 || options.every((o) => selected.includes(o.id));
  const chips: { id: string | null; label: string; on: boolean }[] = [
    ...(showAll ? [{ id: null, label: t('common.all'), on: allOn }] : []),
    ...options.map((o) => ({
      id: o.id,
      label: o.pluralLabel ?? o.label,
      // With All on (and shown), it alone reads as pressed.
      on: showAll && allOn ? false : selected.includes(o.id),
    })),
  ];

  return (
    <fieldset
      aria-label={t('browse.domain_group')}
      className="m-0 flex min-w-0 gap-2 overflow-x-auto border-0 px-4 py-2 [scrollbar-width:none]"
    >
      {chips.map((chip) => (
        <button
          key={chip.id ?? '__all'}
          type="button"
          aria-pressed={chip.on}
          onClick={() => onSelect(chip.id)}
          className={cn(
            'inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            chip.on
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background text-foreground hover:bg-accent',
          )}
        >
          {chip.label}
        </button>
      ))}
    </fieldset>
  );
}
