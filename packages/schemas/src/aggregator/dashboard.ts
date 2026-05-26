import z from 'zod';

const StatusEnum = z.enum(['new', 'active', 'at_risk', 'inactive']);
const BucketEnum = z.enum(['create', 'accept', 'reject', 'cancel']);

/**
 * Query parameters for GET /api/v1/aggregator/dashboard.
 *
 * page, limit  — offset pagination over item_metrics.
 * domain       — narrows the response to one of org.metadata.domains.
 * status       — filter item rows by profile_status.
 * q            — free-text search (accepted, not yet wired).
 * refresh      — force recompute, bypass TTL, blocking advisory lock.
 */
export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
  refresh: z.enum(['true', 'false']).transform((v) => v === 'true').optional().default(false),
});

export const ItemRollup = z.object({
  // 7 fixed tiles
  total_items: z.number(),
  complete_profiles: z.number(),
  has_applications: z.number(),
  by_status: z.record(StatusEnum, z.number()),

  // generic derived (network-agnostic)
  by_action_status: z.record(BucketEnum, z.number()),
  avg_items_per_user: z.number(),
  avg_actions_per_user: z.number(),
  mode_wise_counts: z.record(z.string(), z.number()),
});

/**
 * One item row. Same shape across every domain — no NULL-on-other-side.
 * Acting org context is implicit from the calling header, so item_id,
 * owner_user_id, onboarded_by_org_id are intentionally omitted.
 */
export const ItemRow = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  name: z.string(),
  onboarded_via: z.string().nullable(),

  profile_status: StatusEnum.nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),

  count_create: z.number(),
  count_accept: z.number(),
  count_reject: z.number(),
  count_cancel: z.number(),

  last_create_at: z.string().nullable(),
  last_accept_at: z.string().nullable(),
  last_reject_at: z.string().nullable(),
  last_cancel_at: z.string().nullable(),

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
