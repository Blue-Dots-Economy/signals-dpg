import { is_populated } from '../metrics/profile_completion.js';
import type { JSONSchemaLike } from '../metrics/profile_completion.js';
import type { GoLiveGate } from '@dpg/schemas';

/** Everything a go-live gate check might read, assembled once per classification. */
export interface GoLiveContext {
  schema: JSONSchemaLike | null | undefined;
  state: Record<string, unknown>;
  /**
   * `consent_required`: whether `profile_creation` consent is accepted by the
   * correct signer. The caller folds in the guardian check (a gated minor needs
   * a `source='guardian'` row), so the age control can never be a separate,
   * forgettable step.
   */
  consentSatisfied: boolean;
  /** `owner_required`: whether the profile owner has an owning aggregator. */
  hasOwner: boolean;
  /**
   * `owner_required`: whether a default aggregator is nominated for this
   * item's (network, domain) binding. See guard 1 below.
   */
  defaultConfigured: boolean;
  /**
   * The item's lifecycle status before this write. Read only by
   * `owner_required` (guard 2); every other gate is a pure function of the
   * item's own state and must stay that way.
   */
  currentStatus: 'draft' | 'live' | 'paused' | 'retired';
}

/**
 * The gate registry: the single place that maps a `go_live_required` token to
 * its logic. A profile goes live only when every gate its domain lists passes.
 * To add a gate, add the token to `PROFILE_GO_LIVE_GATES` (@dpg/schemas) and
 * one entry here; nothing else branches on gate identity.
 */
export const GO_LIVE_GATE_CHECKS: Record<GoLiveGate, (ctx: GoLiveContext) => boolean> = {
  schema_required: (ctx) => (ctx.schema?.required ?? []).every((k) => is_populated(ctx.state[k])),
  consent_required: (ctx) => ctx.consentSatisfied,
  /**
   * A profile may not go live while nobody owns its account.
   *
   * Unlike the other gates this is not a pure function of the item's state: it
   * reads the prior status and instance config. Both guards are load-bearing:
   *
   * Guard 1: inert while no default aggregator is nominated for the binding.
   *   The default is nominated after launch, and without this every self-signup
   *   profile would be stuck in `draft` until then. A boolean is safe only
   *   because `organization_default_binding_exclusive` (migration 0014) means a
   *   binding is never contested; otherwise "not configured" and "cannot tell"
   *   would need opposite answers.
   *
   * Guard 2: blocks `draft → live` only, never demotes a live profile.
   *   `classify_item` runs on every write, so without it an already-live,
   *   unowned user editing one field would drop to `draft` and silently vanish
   *   from discover and the map (search read paths are live-only).
   */
  owner_required: (ctx) => {
    if (ctx.currentStatus === 'live') return true;
    if (!ctx.defaultConfigured) return true;
    // `hasOwner` means "has any owning aggregator", not "the one for this
    // item's domain". These coincide for single-domain accounts, but a legacy
    // account with items in two domains could pass with the other domain's
    // owner. No shipped `network.json` enables `owner_required`; resolve this
    // before one does.
    return ctx.hasOwner;
  },
};

/** True when every configured gate passes for this context. */
export const passesGoLiveGates = (
  gates: readonly GoLiveGate[],
  ctx: GoLiveContext,
): boolean => gates.every((gate) => GO_LIVE_GATE_CHECKS[gate](ctx));
