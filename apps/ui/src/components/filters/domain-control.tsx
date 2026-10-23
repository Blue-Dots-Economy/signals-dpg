import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface DomainOption {
  id: string;
  /** Singular, for the toggle buttons — each names one domain. */
  label: string;
  /** Plural, for the single-domain label ("Showing Providers"). Falls back to `label`. */
  pluralLabel?: string;
}

export interface DomainControlProps {
  options: DomainOption[];
  /**
   * 'single' on the list, since one `/discover` call takes exactly one
   * `item_domain`. 'multi' on the map, which issues one `/markers` request per
   * domain.
   */
  mode: 'single' | 'multi';
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * The browse domain control. Callers pass only the domains the viewer can
 * browse (a permanently disabled domain button reads as broken);
 * `computeVisibleDomains` governs what is fetchable, and this component only
 * renders what it is given.
 *
 * Neither mode can reach an empty selection: the list needs one domain to
 * fetch, and an empty map selection would leave a blank map.
 */
export function DomainControl({
  options,
  mode,
  selected,
  onChange,
}: Readonly<DomainControlProps>) {
  const { t } = useTranslation();

  const toggle = (id: string) => {
    if (mode === 'single') {
      // Re-picking the only selection is a no-op, not a deselection.
      if (selected.length === 1 && selected[0] === id) return;
      onChange([id]);
      return;
    }

    const isOn = selected.includes(id);
    if (isOn && selected.length === 1) return;
    onChange(isOn ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  // One browsable domain: no choice to offer, so state the domain instead.
  if (options.length <= 1) {
    const only = options[0];
    if (!only) return null;
    return (
      // An <h1>: this is the browse page's only statement of what is on
      // screen, so it carries the heading rank.
      <h1
        data-testid="domain-single-label"
        className="text-xl font-semibold tracking-tight text-foreground"
      >
        {t('browse.domain_only', { domain: only.pluralLabel ?? only.label })}
      </h1>
    );
  }

  return (
    // <fieldset> rather than <div role="group"> for the native implicit group
    // role (Sonar S6819). `m-0 min-w-0 p-0` resets the UA fieldset chrome.
    <fieldset
      data-tour="domain-control"
      aria-label={t('browse.domain_group')}
      // Horizontal scroll rather than wrap, so a network with many domains
      // does not eat a phone screen. The buttons' `h-9` matches the other
      // toolbar triggers in the row.
      className="m-0 inline-flex min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-background p-0"
    >
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(o.id)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border px-3 text-sm font-semibold transition-colors last:border-r-0',
              'pointer-coarse:min-h-11',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              on
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {mode === 'multi' && on && <Check className="h-3.5 w-3.5 shrink-0" />}
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
