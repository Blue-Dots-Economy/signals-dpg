import type { NetworkConfigDocument } from '@dpg/schemas';

export interface MetricCategoriesTriple {
  shortlisted: string[];
  rejected: string[];
  pending: string[];
}

export interface ResolveInput {
  actionType: string;
  fromDomain: string;
  toDomain: string;
}

/**
 * Resolve the metric_categories triple for a `(action_type, from_domain,
 * to_domain)` interaction in a network's config. Returns `null` when:
 *   - The action_type isn't declared,
 *   - No interaction matches the (from, to) direction, or
 *   - The matching interaction has `metric_categories: null` (or absent).
 *
 * Plan B's recompute treats null identically to a zeroed triple — all
 * counts stay 0 for that direction (e.g. provider→seeker invites today).
 */
export const resolve_metric_categories = (
  networkConfig: NetworkConfigDocument,
  input: ResolveInput,
): MetricCategoriesTriple | null => {
  const action = networkConfig.actions[input.actionType];
  if (!action) return null;

  const interaction = action.interactions.find(
    (entry) =>
      entry.from_domain === input.fromDomain &&
      entry.to_domain === input.toDomain,
  );
  if (!interaction) return null;

  const mc = (interaction as { metric_categories?: MetricCategoriesTriple | null })
    .metric_categories;
  if (!mc) return null;
  return {
    shortlisted: mc.shortlisted ?? [],
    rejected: mc.rejected ?? [],
    pending: mc.pending ?? [],
  };
};

export interface DiscoveredMetricCategories {
  actionType: string;
  fromDomain: string;
  toDomain: string;
  categories: MetricCategoriesTriple;
}

/**
 * Find the first action/interaction in the network config that declares
 * `metric_categories`. Returns the action_type + direction + categories so the
 * recompute pipeline can drive the SQL filter from network config rather than
 * a hardcoded action name.
 *
 * Returns null if no interaction declares metric_categories anywhere — yellow_dot
 * sits here today, and recompute treats that as "0 application counts."
 *
 * Iteration order is insertion order of `actions` keys, then declared order of
 * the action's `interactions[]`. If a future network declares metric_categories
 * on multiple interactions we'll need an explicit selector — for now first-match
 * matches the single-application-action assumption baked into the 3-bucket model.
 */
export const discover_metric_categories = (
  networkConfig: NetworkConfigDocument,
): DiscoveredMetricCategories | null => {
  const actions = networkConfig.actions ?? {};
  for (const [actionType, action] of Object.entries(actions)) {
    for (const interaction of action.interactions) {
      const mc = (interaction as { metric_categories?: MetricCategoriesTriple | null })
        .metric_categories;
      if (!mc) continue;
      const shortlisted = mc.shortlisted ?? [];
      const rejected = mc.rejected ?? [];
      const pending = mc.pending ?? [];
      if (shortlisted.length === 0 && rejected.length === 0 && pending.length === 0) {
        continue;
      }
      return {
        actionType,
        fromDomain: interaction.from_domain,
        toDomain: interaction.to_domain,
        categories: { shortlisted, rejected, pending },
      };
    }
  }
  return null;
};
