import z from 'zod';

/**
 * Query parameters for GET /api/v1/aggregator/dashboard.
 *
 * page, limit — offset pagination over participant_metrics.
 * status     — filter rows by profile_status (UI status-tab navigation).
 * q          — free-text search; NOT implemented in pilot but accepted
 *              and ignored. Documented as a Plan 3 follow-up.
 */
export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']).optional(),
  q: z.string().min(1).max(200).optional(),
});

/**
 * One row in the participants list.
 *
 * Snake_case field names — Drizzle's camelCase is mapped to snake_case at
 * the route handler boundary. profile_* timestamps are ISO strings (the
 * Drizzle Date is .toISOString()ed before serialization).
 */
export const ParticipantRow = z.object({
  user_id: z.string(),
  profile_status: z.string().nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),
  applications_pending: z.number(),
  applications_accepted: z.number(),
  applications_rejected: z.number(),
  applications_total: z.number(),
  actionable_tags: z.array(z.string()),
});

/**
 * Aggregated counts shown at the top of the dashboard.
 *
 * by_status is keyed by the same status values DashboardRequestQuery.status
 * accepts, plus 'unknown' as a fallback for any null status rows.
 */
export const RollupSummary = z.object({
  participants_total: z.number(),
  by_status: z.record(z.string(), z.number()),
  applications_pending: z.number(),
  applications_accepted: z.number(),
  applications_rejected: z.number(),
});

/**
 * Response shape for GET /api/v1/aggregator/dashboard.
 *
 * metadata exposes the cache contract — UI can show "last updated"
 * + a soft "refreshing…" indicator when refreshed=true.
 */
export const DashboardResponse = z.object({
  rollup: RollupSummary,
  participants: z.array(ParticipantRow),
  next_cursor: z.string().nullable(),
  total_matching: z.number(),
  metadata: z.object({
    last_computed_at: z.string().nullable(),
    ttl_seconds: z.number(),
    refreshed: z.boolean(),
  }),
});

/**
 * Query for GET /api/v1/aggregator/dashboard/export. Same status/q filters
 * as the dashboard; no pagination — export streams everything that matches.
 */
export const ExportQuery = z.object({
  status: z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']).optional(),
  q: z.string().min(1).max(200).optional(),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type ParticipantRow = z.infer<typeof ParticipantRow>;
export type RollupSummary = z.infer<typeof RollupSummary>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
