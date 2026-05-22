import z from 'zod';

/**
 * Body for POST /api/v1/admin/aggregator/upsert.
 *
 * Called by aggregator-dpg (or any integrating DPG) to mirror its own
 * aggregator record into Signals' organization table. Idempotent —
 * a second call with the same `slug` updates the existing row.
 *
 * external_id is opaque to Signals — it's the upstream system's primary key
 * for the aggregator; stored in organization.metadata for cross-system
 * traceability. Lookups are by slug, not external_id, to avoid a schema
 * change on organization.
 */
export const AggregatorUpsertRequest = z.object({
  external_id: z.string().min(1).describe('aggregator-dpg primary key for this aggregator'),
  name: z.string().min(1).describe('display name'),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric + hyphens')
    .describe('stable url-safe identifier; lookup key for upsert'),
  logo_url: z.url().optional().describe('optional logo url shown in dashboards'),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('opaque metadata stored alongside external_id on the org'),
});

export const AggregatorUpsertResponse = z.object({
  org_id: z.string().describe('Signals organization id (prefixed org_<uuid>)'),
  created: z.boolean().describe('true on first upsert; false when an existing org was updated'),
});

export type AggregatorUpsertRequest = z.infer<typeof AggregatorUpsertRequest>;
export type AggregatorUpsertResponse = z.infer<typeof AggregatorUpsertResponse>;
