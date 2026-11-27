import z from '@dpg/schemas';

/**
 * The canonical action buckets. Network-specific `event_schema.status` values
 * map to these via each interaction's `metric_categories` in network.json.
 * These names appear in column names, API fields and the status-rule DSL.
 */
export const CANONICAL_BUCKETS = Object.freeze(['create', 'accept', 'reject', 'cancel'] as const);
export type CanonicalBucket = (typeof CANONICAL_BUCKETS)[number];
export const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);

/**
 * The fixed statuses every item lands in after recompute. network.json
 * status_rules may emit only these (the config validator rejects others), and
 * the final `default` rule guarantees no item is left with a null status.
 */
export const CANONICAL_STATUSES = Object.freeze(['new', 'active', 'at_risk', 'inactive'] as const);
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];
export const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);
