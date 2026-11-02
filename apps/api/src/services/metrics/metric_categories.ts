import type { NetworkConfigDocument } from '@dpg/schemas';
import { CANONICAL_BUCKETS, type CanonicalBucket } from './buckets.js';

/** Per-bucket arrays of raw `event_schema.status` values that map to each canonical bucket. */
export type MetricCategoriesMap = Record<CanonicalBucket, string[]>;

export interface InteractionWithCategories {
  actionType: string;
  fromDomain: string;
  toDomain: string;
  categories: MetricCategoriesMap;
}

const empty_categories = (): MetricCategoriesMap => ({
  create: [],
  accept: [],
  reject: [],
  cancel: [],
});

const normalize = (
  raw: Partial<MetricCategoriesMap> | null | undefined,
): MetricCategoriesMap | null => {
  if (!raw) return null;
  const out = empty_categories();
  for (const b of CANONICAL_BUCKETS) {
    out[b] = raw[b] ?? [];
  }
  if (CANONICAL_BUCKETS.every((b) => out[b].length === 0)) return null;
  return out;
};

/**
 * Collects every interaction whose `metric_categories` is non-empty (null or
 * empty means "not tracked"), with its (action_type, from_domain, to_domain)
 * tuple and canonical mapping. Recompute aggregates item_actions in both
 * directions from this list.
 */
export const collect_tracked_interactions = (
  networkConfig: NetworkConfigDocument,
): InteractionWithCategories[] => {
  const out: InteractionWithCategories[] = [];
  for (const [actionType, action] of Object.entries(networkConfig.actions ?? {})) {
    for (const interaction of action.interactions) {
      const raw = (interaction as { metric_categories?: Partial<MetricCategoriesMap> | null })
        .metric_categories;
      const categories = normalize(raw);
      if (!categories) continue;
      out.push({
        actionType,
        fromDomain: interaction.from_domain,
        toDomain: interaction.to_domain,
        categories,
      });
    }
  }
  return out;
};
