import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { user, organization } from './auth.js';

/**
 * Cached per-participant metrics for the aggregator dashboard.
 *
 * Owner: apps/api/src/services/metrics/recompute.ts (the recompute path is
 * the only writer). The dashboard route is a pure reader. The TTL contract
 * lives in apps/api/src/services/metrics/staleness.ts — last_computed_at
 * is the only field that matters for staleness.
 *
 * onboarded_by_org_id is denormalised from `user.onboardedByOrgId` (Plan 2)
 * so the dashboard can scope without a join. Recompute keeps it in sync.
 */
export const participant_metrics = pgTable('participant_metrics', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  applicationsPending: integer('applications_pending').default(0),
  applicationsAccepted: integer('applications_accepted').default(0),
  applicationsRejected: integer('applications_rejected').default(0),
  applicationsTotal: integer('applications_total').default(0),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
});
