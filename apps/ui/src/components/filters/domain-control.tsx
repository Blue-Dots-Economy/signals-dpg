import * as React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface DomainOption {
  id: string;
  /** Singular, for the toggle buttons — each names one domain. */
  label: string;
  /**
   * Plural, for the collapsed single-domain label, which names the SET on
   * screen ("Showing Providers"). Falls back to `label`.
   */
  pluralLabel?: string;
  /** False for a domain the viewer's own domain cannot initiate toward. */
  available: boolean;
  /** Shown when `available` is false — one short human sentence, already localized. */
  unavailableReason?: string;
}

export interface DomainControlProps {
  options: DomainOption[];
  /**
   * 'single' on the list — one `/discover` call takes exactly one
   * `item_domain`. 'multi' on the map, which already issues one `/markers`
   * request per domain, so several cost nothing structural.
   */
  mode: 'single' | 'multi';
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * The one domain control (#645, spec D10/D11).
 *
 * Replaces THREE things: the sidebar Browse tab, the facet panel's own domain
 * multi-select, and the invisible scoping that silently removed domains from a
 * signed-in viewer's world. Domain IS a filter, so it belongs with the other
 * filters rather than in navigation.
 *
 * Unavailable domains are LISTED and explained rather than hidden (spec D7).
 * `computeVisibleDomains` dropped non-interacting domains entirely, which users
 * experienced as those domains not existing. The interaction matrix itself is
 * untouched here — only made legible.
 *
 * Neither mode can reach an empty selection: the list needs exactly one domain
 * to fetch at all, and an empty map selection would render a blank map with no
 * obvious way back.
 */
export function DomainControl({
  options,
  mode,
  selected,
  onChange,
}: Readonly<DomainControlProps>) {
  const { t } = useTranslation();

  const toggle = (id: string, available: boolean) => {
    if (!available) return;

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

  // Exactly one selectable domain → there is no choice to offer, so state the
  // domain instead of rendering a control (Q1). A network whose interaction
  // matrix gives a seeker no seeker->seeker edge otherwise showed a permanently
  // disabled `Seeker` button next to `Provider`, which reads as a broken
  // control rather than as "this is the only thing you can browse".
  const selectable = options.filter((o) => o.available);
  if (selectable.length <= 1) {
    const only = selectable[0];
    if (!only) return null;
    return (
      <p
        data-testid="domain-single-label"
        className="text-xs font-semibold text-muted-foreground"
      >
        {t('browse.domain_only', { domain: only.pluralLabel ?? only.label })}
      </p>
    );
  }

  return (
    // <fieldset> rather than <div role="group">: it carries an IMPLICIT group
    // role, so assistive tech and `getByRole('group')` behave identically while
    // using the native element (Sonar S6819). `min-w-0 p-0 m-0 border-0` resets
    // the UA's default fieldset chrome so the border below is ours.
    <fieldset
      aria-label={t('browse.domain_group')}
      // Horizontal scroll rather than wrap: wrapping a 4+ domain network would
      // eat a phone screen, and this bar is sticky (spec §7.5). No live network
      // exceeds three domains today.
      className="m-0 inline-flex min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-background p-0"
    >
      {options.map((o) => {
        const on = selected.includes(o.id);
        const reasonId = o.unavailableReason ? `domain-why-${o.id}` : undefined;
        return (
          <React.Fragment key={o.id}>
            <button
              type="button"
              disabled={!o.available}
              aria-pressed={on}
              aria-describedby={reasonId}
              onClick={() => toggle(o.id, o.available)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border px-3 py-1.5 text-xs font-semibold transition-colors last:border-r-0',
                'pointer-coarse:min-h-11',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                on && 'bg-primary text-primary-foreground',
                !on && o.available && 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                !o.available && 'cursor-not-allowed text-muted-foreground/40',
              )}
            >
              {mode === 'multi' && on && <Check className="h-3 w-3 shrink-0" />}
              {o.label}
            </button>
            {reasonId && (
              // Always available to assistive tech via aria-describedby. The
              // visible treatment is a tooltip, added where this is composed —
              // the reason cannot fit inline on a phone (spec §7.5).
              <span id={reasonId} className="sr-only">
                {o.unavailableReason}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </fieldset>
  );
}
