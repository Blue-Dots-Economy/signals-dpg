import { useTranslation } from 'react-i18next';
import { ArrowDownUp } from 'lucide-react';
import { OptionSelect } from './option-select';
import type { BrowseSort } from '@/lib/browse-discover';

export interface SortSelectProps {
  /** What the user asked for. */
  value: BrowseSort;
  /**
   * What the server applied (`meta.sort_applied`). The trigger labels from
   * this, not `value`: a `relevance` request with no anchor and no typed text
   * degrades to `newest` server-side.
   */
  applied?: BrowseSort;
  /**
   * A response reported no order (`meta.sort_applied` absent, from a search
   * service without explicit sort). The order is unknown, so the trigger names
   * none; the popover still ticks the requested choice.
   */
  appliedUnreported?: boolean;
  /** False when no viewer location resolves — `nearest` then has no centre. */
  nearestAvailable: boolean;
  /**
   * What `relevance` means here: 'profile' when an anchor is sent (profile to
   * item cosine), 'search' when the typed text is the query vector, or null.
   */
  basis: 'profile' | 'search' | null;
  /**
   * False when the server cannot rank by relevance for this request: no anchor
   * and no typed text, or signals-search is unreachable and the BFF fell back
   * to the native path (`meta.source: 'native_fallback'`). The option is then
   * omitted.
   */
  relevanceAvailable?: boolean;
  /**
   * Which centre `nearest` measures from, already localized. A read-only hint:
   * the source is chosen only in the Location control.
   */
  nearestFromLabel?: string;
  onChange: (next: BrowseSort) => void;
}

/**
 * The sort selector, list view only. It states the ranking basis once in the
 * pinned toolbar, which is why the card match pill can stay icon-only.
 *
 * Design: docs/architecture/ui-components-browse-controls.md
 */
export function SortSelect({
  value,
  applied,
  appliedUnreported = false,
  nearestAvailable,
  basis,
  relevanceAvailable = true,
  nearestFromLabel,
  onChange,
}: Readonly<SortSelectProps>) {
  const { t } = useTranslation();

  const relevanceLabel =
    basis === 'search'
      ? t('browse.sort_relevance_search')
      : t('browse.sort_relevance_profile');

  const labelFor = (sort: BrowseSort): string => {
    switch (sort) {
      case 'relevance':
        return relevanceLabel;
      case 'nearest':
        return t('browse.sort_nearest');
      default:
        return t('browse.sort_newest');
    }
  };

  // Label from what the server applied, falling back to the request before the
  // first response. `undefined` when the server reported no order.
  const effective = appliedUnreported ? undefined : (applied ?? value);

  /**
   * Relevance was requested but the server applied something else.
   * `relevanceAvailable` is only a client-side prediction and cannot see
   * whether signals-search could use the anchor (e.g. an unindexed profile).
   * Without this, the trigger and tick would disagree, and re-picking
   * relevance would be a no-op because `sort` already holds it.
   */
  const relevanceRefused =
    // Unreported counts as refused: we cannot claim relevance was applied.
    appliedUnreported ||
    (value === 'relevance' && applied !== undefined && applied !== 'relevance');

  return (
    <OptionSelect<BrowseSort>
      name={t('browse.sort_label')}
      displayLabel={effective ? labelFor(effective) : ''}
      icon={ArrowDownUp}
      // Tick the applied order so trigger and tick agree. When the server
      // reported no order, tick the request; the trigger stays blank.
      value={effective ?? value}
      onChange={onChange}
      options={[
        // Listed with a reason, not omitted, when the server refuses it, so a
        // row the viewer already chose does not silently vanish.
        ...(relevanceAvailable
          ? [
              {
                value: 'relevance' as const,
                label: relevanceLabel,
                available: !relevanceRefused,
                reason: relevanceRefused
                  ? t('browse.sort_relevance_unavailable')
                  : undefined,
              },
            ]
          : []),
        // The hint names the basis (posting date, `items.created_at`), not the
        // last-edit date.
        {
          value: 'newest' as const,
          label: t('browse.sort_newest'),
          hint: t('browse.sort_newest_hint'),
        },
        {
          value: 'nearest',
          label: t('browse.sort_nearest'),
          available: nearestAvailable,
          reason: nearestAvailable ? undefined : t('browse.sort_nearest_unavailable'),
          hint:
            nearestAvailable && nearestFromLabel
              ? t('browse.sort_nearest_from', { source: nearestFromLabel })
              : undefined,
        },
      ]}
    />
  );
}
