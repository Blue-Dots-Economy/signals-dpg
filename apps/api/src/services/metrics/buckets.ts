// apps/api/src/services/metrics/buckets.ts
import z from '@dpg/schemas';

/**
 * The 4 canonical action buckets every action event in Signals maps into.
 * Network-specific event_schema.status enum values are mapped to these via
 * each interaction's `metric_categories` block in network.json. These names
 * appear in column names, API field names, and the status-rule DSL — they
 * are the Signals-internal vocabulary, not a network's wire format.
 */
export const CANONICAL_BUCKETS = ['create', 'accept', 'reject', 'cancel'] as const;
export type CanonicalBucket = (typeof CANONICAL_BUCKETS)[number];
export const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);

/**
 * The 4 fixed status buckets every item lands in after recompute. Rule
 * authors in network.json's status_rules MUST emit only these values;
 * the network-config validator rejects anything else. The final
 * `default` tail rule guarantees no item is left with a null status.
 */
export const CANONICAL_STATUSES = ['new', 'active', 'at_risk', 'inactive'] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];
export const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);
