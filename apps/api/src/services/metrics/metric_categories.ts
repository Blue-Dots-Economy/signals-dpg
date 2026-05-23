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
