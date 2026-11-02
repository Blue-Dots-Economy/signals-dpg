import type { JSONSchemaLike } from '../metrics/profile_completion.js';
import type { GoLiveGate } from '@dpg/schemas';
import { passesGoLiveGates } from './go_live_gates.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused' | 'retired';
export type { GoLiveGate };

/**
 * Default gate set when a domain does not declare `go_live_required`.
 * `consent_required` is opt-in per domain, except that `resolveGoLiveGates`
 * force-adds it for a guardian-gated domain. Per-gate logic lives in
 * `go_live_gates.ts`.
 */
export const DEFAULT_GO_LIVE_GATES: readonly GoLiveGate[] = ['schema_required'];

export interface ClassifierInput {
  schema: JSONSchemaLike | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status before this write; pass `'draft'` for a new item.
   * The classifier never moves out of `paused` or `retired`.
   */
  current_status: LifecycleStatus;
  /**
   * Whether the item owner has accepted `profile_creation` consent by the
   * correct signer, from the consent ledger. Only consulted when the
   * `consent_required` gate is active. For a guardian-gated minor the caller
   * must fold the guardian check into this value.
   */
  consent_accepted: boolean;
  /** Gates that must pass for `live`. Defaults to `DEFAULT_GO_LIVE_GATES`. */
  gates?: readonly GoLiveGate[];
  /**
   * For `owner_required` only. Resolve with `resolveOwnerGateContext`
   * (`services/aggregator/default_aggregator.ts`) and pass it whenever `gates`
   * includes `owner_required`.
   *
   * Omitted fails closed ("a default exists and the owner has none"): a
   * forgotten context leaves profiles in `draft`, which is visible and
   * recoverable, rather than silently publishing unowned profiles.
   */
  owner_context?: { has_owner: boolean; default_configured: boolean };
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
}

/**
 * Pure synchronous classifier over the merged post-write state.
 *
 * `retired` is terminal and `paused` is sticky; otherwise `live` requires every
 * configured gate to pass, else `draft`. Exception: `owner_required` lets an
 * already-`live` profile through; read `GO_LIVE_GATE_CHECKS.owner_required`
 * before changing this function. Profile completion % is computed separately
 * and is independent of the gate set.
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  if (input.current_status === 'retired') {
    return { lifecycle_status: 'retired' };
  }

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused' };
  }

  const gates = input.gates ?? DEFAULT_GO_LIVE_GATES;
  const live = passesGoLiveGates(gates, {
    schema: input.schema,
    state: input.merged_state ?? {},
    consentSatisfied: input.consent_accepted,
    // Fail closed when the caller configured `owner_required` but passed no
    // owner context — see `owner_context` on ClassifierInput.
    hasOwner: input.owner_context?.has_owner ?? false,
    defaultConfigured: input.owner_context?.default_configured ?? true,
    currentStatus: input.current_status,
  });
  return { lifecycle_status: live ? 'live' : 'draft' };
};
