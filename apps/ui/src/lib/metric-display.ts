import type { TFunction } from 'i18next';
import type { BrowseSort } from '@/lib/browse-discover';

export type CardMetric =
  | { kind: 'relevance'; percent: number }
  | { kind: 'distance'; meters: number }
  | { kind: 'age'; createdAt: Date }
  | null;

/**
 * The card metric is the ranking basis: it shows whatever drove the item's
 * position and nothing when the metric did not determine the order, so the
 * list's order and each card's number always agree.
 *
 * Keyed off the sort the server applied, never the requested one: a
 * `relevance` request with neither an anchor nor typed text degrades to
 * `newest` server-side.
 */
export function resolveCardMetric(input: {
  sortApplied: BrowseSort | undefined;
  score?: number | null;
  distanceMeters?: number | null;
  createdAt?: Date | null;
  /**
   * `VITE_FREETEXT_MATCH_SCORE_ENABLED`: whether this deployment shows a score
   * for free-text matches, or only for profile matches.
   */
  freeTextScoreEnabled: boolean;
  hasProfile: boolean;
}): CardMetric {
  switch (input.sortApplied) {
    case 'relevance': {
      if (input.score == null) return null;
      // Without a profile the score is typed-text↔item, a different quantity
      // some deployments choose not to surface.
      if (!input.hasProfile && !input.freeTextScoreEnabled) return null;
      return { kind: 'relevance', percent: input.score };
    }
    case 'nearest':
      return input.distanceMeters == null
        ? null
        : { kind: 'distance', meters: input.distanceMeters };
    case 'newest':
      return input.createdAt == null ? null : { kind: 'age', createdAt: input.createdAt };
    default:
      // No reported sort (e.g. before the first response): do not guess.
      return null;
  }
}

/** Renders a `CardMetric` as the short string the pill displays. */
export function formatCardMetric(metric: CardMetric, t: TFunction): string | null {
  if (!metric) return null;
  switch (metric.kind) {
    case 'relevance':
      return `${Math.round(metric.percent)}%`;
    case 'distance':
      return metric.meters >= 1000
        ? t('card.metric_km', { km: (metric.meters / 1000).toFixed(1) })
        : t('card.metric_m', { m: Math.round(metric.meters) });
    case 'age': {
      const days = Math.floor((Date.now() - metric.createdAt.getTime()) / 86_400_000);
      return days < 1 ? t('card.metric_today') : t('card.metric_days_ago', { count: days });
    }
  }
}

/**
 * The full basis sentence, for the pill tooltip and the explanation panel.
 * The pill itself stays icon-only because the sticky toolbar states the basis
 * once.
 */
export function describeCardMetric(
  metric: CardMetric,
  basis: 'profile' | 'search' | null,
  t: TFunction,
): string | null {
  if (!metric) return null;
  switch (metric.kind) {
    case 'relevance':
      return basis === 'search'
        ? t('browse.sort_relevance_search')
        : t('browse.sort_relevance_profile');
    case 'distance':
      return t('card.metric_distance_desc');
    case 'age':
      return t('card.metric_age_desc');
  }
}
