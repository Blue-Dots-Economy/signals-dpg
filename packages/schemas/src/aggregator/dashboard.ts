import z from 'zod';

const StatusEnum = z.enum(['new', 'active', 'at_risk', 'inactive']);
const BucketEnum = z.enum(['create', 'accept', 'reject', 'cancel']);
const LifecycleEnum = z.enum(['draft', 'live', 'paused', 'retired']);

/**
 * Query parameters for GET /api/v1/aggregator/dashboard.
 *
 * page, limit  — offset pagination over item_metrics.
 * domain       — narrows the response to one of org.metadata.domains.
 * status       — filter item rows by profile_status.
 * lifecycle    — comma-separated lifecycle_status values; default 'live,draft'.
 * q            — free-text search (accepted, not yet wired).
 * refresh      — force recompute, bypass TTL, blocking advisory lock.
 */
export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  lifecycle: z.string().min(1).optional()
    .describe("Comma-separated lifecycle_status values, e.g. 'live,draft'. Default: live,draft."),
  q: z.string().min(1).max(200).optional(),
  refresh: z.enum(['true', 'false']).transform((v) => v === 'true').optional().default(false),
});

export const ItemRollup = z.object({
  // profile-level tiles
  total_items: z.number(),
  complete_profiles: z.number(),
  has_applications: z.number(),
  by_status: z.record(StatusEnum, z.number()),

  // directional action rollups (replace the former blended by_action_status)
  by_initiated_action_status: z.record(BucketEnum, z.number()),
  by_received_action_status: z.record(BucketEnum, z.number()),

  // user-level (computed over the full dataset, not the paginated page)
  total_users: z.number(),
  avg_items_per_user: z.number(),
  avg_actions_per_user: z.number(),
  mode_wise_counts: z.record(z.string(), z.number()),
});

/**
 * One item row — one row per profile. `profile_item_id` is the required
 * per-row key (a user with N profiles is N rows, so `user_id` is not unique
 * per row). `user_id` is an optional passthrough for traceability / future
 * profile→user drill-in; no aggregator compute depends on it.
 *
 * `initiated` / `received` are full count maps (every bucket present).
 * `last_initiated_at` / `last_received_at` are SPARSE — only buckets that
 * actually occurred carry a timestamp; absent buckets are omitted (no nulls).
 */
export const ItemRow = z.object({
  profile_item_id: z.string(),
  user_id: z.string().nullable(),

  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  name: z.string(),
  onboarded_via: z.string().nullable(),

  profile_status: StatusEnum.nullable(),
  lifecycle_status: LifecycleEnum.optional(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),

  initiated: z.record(BucketEnum, z.number()),
  received: z.record(BucketEnum, z.number()),
  last_initiated_at: z.partialRecord(BucketEnum, z.string()),
  last_received_at: z.partialRecord(BucketEnum, z.string()),

  actionable_tags: z.array(z.string()),
});

export const DomainBlock = z.object({
  rollup: ItemRollup,
  items: z.array(ItemRow),
  total_matching: z.number(),
  next_cursor: z.string().nullable(),
});

export const DashboardResponse = z.object({
  by_domain: z.record(z.string(), DomainBlock),
  metadata: z.object({
    last_computed_at: z.string().nullable(),
    ttl_seconds: z.number(),
    refreshed: z.boolean(),
  }),
});

export const ExportQuery = z.object({
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
  refresh: z.enum(['true', 'false']).transform((v) => v === 'true').optional().default(false),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type ItemRollup = z.infer<typeof ItemRollup>;
export type ItemRow = z.infer<typeof ItemRow>;
export type DomainBlock = z.infer<typeof DomainBlock>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
