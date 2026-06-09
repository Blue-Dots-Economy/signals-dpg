import { is_populated } from '../metrics/profile_completion.js';
import type { JSONSchemaLike } from '../metrics/profile_completion.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused';

export interface ClassifierInput {
  schema: JSONSchemaLike | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status BEFORE this write. `paused` is sticky — the
   * classifier never flips out of it. For brand-new items pass `'draft'`.
   */
  current_status: LifecycleStatus;
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
}

/**
 * Pure synchronous classifier. Runs inside the item-write transaction over
 * the merged post-write state. See
 * docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md §5.
 *
 * lifecycle_status: paused is sticky; otherwise required_complete ? live : draft.
 * (Completion % is no longer produced here — the single completion metric is
 * `item_metrics.profile_completion_pct`, computed required-only via
 * `profile_completion_pct`.)
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  const required = input.schema?.required ?? [];
  const state = input.merged_state ?? {};

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused' };
  }

  if (required.length === 0) {
    return { lifecycle_status: 'live' };
  }

  const required_complete = required.every((k) => is_populated(state[k]));
  return { lifecycle_status: required_complete ? 'live' : 'draft' };
};
