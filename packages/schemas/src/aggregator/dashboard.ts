import z from 'zod';

/**
 * Query parameters for GET /api/v1/aggregator/dashboard.
 *
 * page, limit — offset pagination over item_metrics (per-domain block).
 * domain     — narrows the response to a single domain (must be in
 *              org.metadata.domains). When omitted, all configured
 *              domains for the acting aggregator are returned.
 * status     — filter item rows by profile_status.
 * q          — free-text search (accepted, not yet wired).
 */
const StatusEnum = z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']);

export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
});

/**
 * Per-domain rollup. by_status is keyed by the same status values
 * DashboardRequestQuery.status accepts (plus 'unknown' fallback).
 */
export const ItemRollup = z.object({
  items_total: z.number(),
  by_status: z.record(z.string(), z.number()),
  applications_total: z.number(),
  applications_pending: z.number(),
  applications_shortlisted: z.number(),
  applications_rejected: z.number(),
  unique_users: z.number(),
  complete_profiles_count: z.number(),
  avg_profiles_per_user: z.number(),
  users_with_applications: z.number(),
  avg_applications_per_user: z.number(),
  new_users_last_7_days: z.number(),
  mode_wise_counts: z.record(z.string(), z.number()),
});

/**
 * One row in a domain's participants list. Snake_case at the API
 * boundary; Drizzle's camelCase columns are mapped before serialize.
 * profile_ and last_*_at timestamps are ISO strings.
 */
export const ParticipantRow = z.object({
  item_id: z.string(),
  item_network: z.string(),
  owner_user_id: z.string(),
  name: z.string().nullable(),
  item_type: z.string(),
  profile_status: z.string().nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),
  applications_total: z.number(),
  applications_pending: z.number(),
  applications_shortlisted: z.number(),
  applications_rejected: z.number(),
  last_applied_at: z.string().nullable().optional(),
  last_shortlisted_at: z.string().nullable().optional(),
  last_rejected_at: z.string().nullable().optional(),
  openings: z.number().nullable().optional(),
  actionable_tags: z.array(z.string()),
});

/**
 * One domain's slice of the dashboard response.
 */
export const DomainBlock = z.object({
  rollup: ItemRollup,
  participants: z.array(ParticipantRow),
  total_matching: z.number(),
  next_cursor: z.string().nullable(),
});

/**
 * Response shape for GET /api/v1/aggregator/dashboard.
 *
 * by_domain maps domain string → DomainBlock. Single-domain orgs
 * (or callers using ?domain=) see one key; multi-domain orgs see
 * one key per configured domain. metadata aggregates the earliest
 * last_computed_at across the per-domain staleness results and
 * "any refreshed" so the UI can show a unified "refreshing…" state.
 */
export const DashboardResponse = z.object({
  by_domain: z.record(z.string(), DomainBlock),
  metadata: z.object({
    last_computed_at: z.string().nullable(),
    ttl_seconds: z.number(),
    refreshed: z.boolean(),
  }),
});

/**
 * Query for GET /api/v1/aggregator/dashboard/export. Same domain/status/q
 * filters as the dashboard; no pagination — export streams everything that
 * matches across the in-scope domains.
 */
export const ExportQuery = z.object({
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type ItemRollup = z.infer<typeof ItemRollup>;
export type ParticipantRow = z.infer<typeof ParticipantRow>;
export type DomainBlock = z.infer<typeof DomainBlock>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
