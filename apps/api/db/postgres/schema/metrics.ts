import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

/**
 * Item-keyed metrics for the aggregator dashboard (Plan B).
 *
 * Replaces the Plan 3 `participant_metrics` table. One row per item
 * (not per user) — a user with two profiles gets two rows; a user
 * spanning seeker + provider gets one row per domain.
 *
 * No FK on item_id — `items` is partitioned and Drizzle's FK story
 * doesn't reach partition keys cleanly. Soft reference via the text
 * column; recompute is the only writer.
 *
 * No cascade on onboarded_by_org_id FK — attribution survives org
 * deletion, matching Plan 2's `user.onboardedByOrgId` convention.
 *
 * profile_status is computed per-domain (seeker vs provider) and is
 * never null in practice — the catch-all in compute_provider_status
 * absorbs any non-matching tail into 'inactive'.
 */
export const item_metrics = pgTable('item_metrics', {
  itemId: text('item_id').primaryKey(),
  itemNetwork: text('item_network').notNull(),
  itemDomain: text('item_domain').notNull(),
  itemType: text('item_type').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  applicationsTotal: integer('applications_total').default(0),
  applicationsPending: integer('applications_pending').default(0),
  applicationsShortlisted: integer('applications_shortlisted').default(0),
  applicationsRejected: integer('applications_rejected').default(0),

  // Seeker-only (NULL for provider rows)
  lastAppliedAt: timestamp('last_applied_at'),

  // Provider-only (NULL for seeker rows)
  lastShortlistedAt: timestamp('last_shortlisted_at'),
  lastRejectedAt: timestamp('last_rejected_at'),
  openings: integer('openings'),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
}, (table) => [
  index('item_metrics_org_domain_status_idx').on(
    table.onboardedByOrgId,
    table.itemDomain,
    table.profileStatus,
  ),
  index('item_metrics_org_domain_last_computed_idx').on(
    table.onboardedByOrgId,
    table.itemDomain,
    table.lastComputedAt,
  ),
  index('item_metrics_owner_domain_idx').on(
    table.ownerUserId,
    table.itemDomain,
  ),
]);
