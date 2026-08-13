import { is_populated } from '../metrics/profile_completion.js';
import type { JSONSchemaLike } from '../metrics/profile_completion.js';
import type { GoLiveGate } from '@dpg/schemas';

/**
 * Everything a go-live gate check might read. The caller assembles this once
 * per classification; each gate check picks the fields it needs. Adding a
 * future gate that needs a new signal → add the signal here and set it at the
 * call sites.
 */
export interface GoLiveContext {
  schema: JSONSchemaLike | null | undefined;
  state: Record<string, unknown>;
  /**
   * `consent_required`: whether `profile_creation` consent is accepted by the
   * CORRECT signer. Guardian-awareness is folded in by the caller (a gated
   * minor needs a `source='guardian'` row), so the gate check stays a plain
   * boolean read and the age control can never be a separate, forgettable step.
   */
  consentSatisfied: boolean;
}

/**
 * The gate registry — the single place that maps a `go_live_required` token to
 * its logic. The classifier is generic over this: it runs whichever gates a
 * domain lists in `network.json`, in order, and a profile goes live only when
 * every one passes. To add a gate: add the token to `PROFILE_GO_LIVE_GATES`
 * (@dpg/schemas) and one entry here. Nothing else branches on gate identity.
 */
export const GO_LIVE_GATE_CHECKS: Record<GoLiveGate, (ctx: GoLiveContext) => boolean> = {
  schema_required: (ctx) => (ctx.schema?.required ?? []).every((k) => is_populated(ctx.state[k])),
  consent_required: (ctx) => ctx.consentSatisfied,
};

/** True when every configured gate passes for this context. */
export const passesGoLiveGates = (
  gates: readonly GoLiveGate[],
  ctx: GoLiveContext,
): boolean => gates.every((gate) => GO_LIVE_GATE_CHECKS[gate](ctx));
