import z from 'zod';

/**
 * Canonical served-domain binding key: `<network>/<domain>` (e.g.
 * `blue_dot/seeker`). Same shape as `binding.key` in apps/api's
 * `served_domain_guard.ts`.
 *
 * Network-qualified on purpose (#640): `network` is an optional request
 * parameter that defaults to `blue_dot`, and `blue_dot` / `purple_dot` both
 * declare `seeker` and `provider` — a bare domain name would be ambiguous the
 * moment one instance serves two networks.
 */
export const BindingKey = z
  .string()
  .regex(/^[a-z0-9_]+\/[a-z0-9_]+$/, 'binding must be "<network>/<domain>", e.g. blue_dot/seeker');

/**
 * Body for POST /api/v1/admin/aggregator/default.
 *
 * Sets which aggregator receives users who arrive with no aggregator of their
 * own — portal self-signup and cold inbound voice (#640, SS-3). Network-service
 * callers only.
 *
 * The tag this drives (`user.onboarded_by_org_id`) is the tenancy key for PII
 * decryption, so the endpoint is transactional and exclusive: setting a binding
 * clears it from whichever org held it before, and writes an audit row.
 *
 * `bindings: []` clears every binding this org holds — the supported way to
 * stand an aggregator down without nominating a replacement. Idempotent.
 */
export const AggregatorDefaultRequest = z.object({
  org_id: z
    .string()
    .min(1)
    .describe('Signals organization id (org_<uuid>) that becomes the default; must be type=aggregator'),
  bindings: z
    .array(BindingKey)
    .describe(
      "served-domain bindings this org becomes the default for, e.g. ['blue_dot/seeker','blue_dot/provider']. Replaces the org's current set; [] clears it.",
    ),
});

export const AggregatorDefaultResponse = z.object({
  org_id: z.string(),
  bindings: z.array(z.string()).describe("the org's bindings after the write"),
  cleared_from: z
    .array(z.object({ org_id: z.string(), binding: z.string() }))
    .describe('bindings taken off another org by this call'),
});

export type AggregatorDefaultRequest = z.infer<typeof AggregatorDefaultRequest>;
export type AggregatorDefaultResponse = z.infer<typeof AggregatorDefaultResponse>;
