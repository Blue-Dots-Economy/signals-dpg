import { useTranslation } from 'react-i18next';
import { OptionSelect } from './option-select';
import type { BrowseSort } from '@/lib/browse-discover';

export interface SortSelectProps {
  /** What the user asked for. */
  value: BrowseSort;
  /**
   * What the server ACTUALLY applied (`meta.sort_applied`). The trigger label
   * renders from this, not from `value`: a `relevance` request with neither an
   * anchor nor typed text degrades to `newest` server-side, and labelling from
   * the request would claim an order we did not get (#644 §3.2).
   */
  applied?: BrowseSort;
  /** False when no viewer location resolves — `nearest` then has no centre. */
  nearestAvailable: boolean;
  /**
   * Which quantity `relevance` means here: 'profile' when an anchor is sent
   * (the score is profile↔item cosine, spec D14), 'search' when there is no
   * anchor and the typed text is the query vector, or null when neither
   * applies.
   */
  basis: 'profile' | 'search' | null;
  onChange: (next: BrowseSort) => void;
}

/**
 * The sort selector (#644/#645 §4.5). List view only — it is ABSENT on the
 * map (spec D26), because ordering is meaningless for a marker layer and a
 * disabled control would invite the question rather than answer it.
 *
 * This control is also what makes the card pill able to stay icon-only
 * (spec D22/D23): it states the ranking basis once, and the toolbar it sits in
 * is sticky, so that statement is on screen at every scroll position instead
 * of being repeated on all twenty cards.
 */
export function SortSelect({
  value,
  applied,
  nearestAvailable,
  basis,
  onChange,
}: Readonly<SortSelectProps>) {
  const { t } = useTranslation();

  const relevanceLabel =
    basis === 'search'
      ? t('browse.sort_relevance_search')
      : t('browse.sort_relevance_profile');

  const labelFor = (sort: BrowseSort): string =>
    sort === 'relevance'
      ? relevanceLabel
      : sort === 'nearest'
        ? t('browse.sort_nearest')
        : t('browse.sort_newest');

  // Label from what happened, falling back to the request only before the
  // first response has arrived.
  const effective = applied ?? value;

  return (
    <OptionSelect<BrowseSort>
      name={t('browse.sort_label')}
      displayLabel={labelFor(effective)}
      value={value}
      onChange={onChange}
      options={[
        { value: 'relevance', label: relevanceLabel },
        { value: 'newest', label: t('browse.sort_newest') },
        {
          value: 'nearest',
          label: t('browse.sort_nearest'),
          available: nearestAvailable,
          reason: nearestAvailable ? undefined : t('browse.sort_nearest_unavailable'),
        },
      ]}
    />
  );
}
