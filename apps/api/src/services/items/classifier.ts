import { is_populated } from '../metrics/profile_completion.js';
import type { JSONSchemaLike } from '../metrics/profile_completion.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused' | 'retired';

export interface ClassifierInput {
  schema: JSONSchemaLike | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status BEFORE this write. `paused` and `retired` are
   * sticky — the classifier never flips out of them (`retired` is terminal).
   * For brand-new items pass `'draft'`.
   */
  current_status: LifecycleStatus;
  /**
   * Whether the item owner has accepted the network's terms + privacy consent
   * (from the consent ledger, not the user-table flags). A profile goes live
   * only when required fields are complete AND consent is accepted
   * (aggregator-dpg#464). Every network is gated — see `hasUserAcceptedConsent`.
   */
  consent_accepted: boolean;
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
}

/**
 * Pure synchronous classifier. Runs inside the item-write transaction over
 * the merged post-write state. See
 * docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md §5.
 *
 * lifecycle_status: retired is terminal and paused is sticky; otherwise live
 * requires BOTH required fields complete AND consent accepted, else draft.
 * (Completion % is no longer produced here — the single completion metric is
 * `item_metrics.profile_completion_pct`, computed required-only via
 * `profile_completion_pct`.)
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  const required = input.schema?.required ?? [];
  const state = input.merged_state ?? {};

  // Terminal: a retired item is permanently removed — never recompute out of it.
  if (input.current_status === 'retired') {
    return { lifecycle_status: 'retired' };
  }

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused' };
  }

  const required_complete = required.every((k) => is_populated(state[k]));
  const live = required_complete && input.consent_accepted;
  return { lifecycle_status: live ? 'live' : 'draft' };
};
