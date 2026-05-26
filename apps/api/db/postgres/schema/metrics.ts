import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

/**
 * Item-keyed metrics for the aggregator dashboard.
 *
 * Each item gets one row. The 4 canonical action buckets
 * (create / accept / reject / cancel) drive all count + last-at columns.
 * display_name is resolved at recompute time from the item's schema-declared
 * display_name_field (or item_id as fallback).
 *
 * No FK on item_id — items is partitioned and Drizzle's FK story doesn't
 * reach partition keys cleanly. Recompute is the only writer.
 *
 * No cascade on onboarded_by_org_id FK — attribution survives org deletion.
 */
export const item_metrics = pgTable('item_metrics', {
  itemId: text('item_id').primaryKey(),
  itemNetwork: text('item_network').notNull(),
  itemDomain: text('item_domain').notNull(),
  itemType: text('item_type').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  displayName: text('display_name').notNull(),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  countCreate: integer('count_create').default(0).notNull(),
  countAccept: integer('count_accept').default(0).notNull(),
  countReject: integer('count_reject').default(0).notNull(),
  countCancel: integer('count_cancel').default(0).notNull(),

  lastCreateAt: timestamp('last_create_at'),
  lastAcceptAt: timestamp('last_accept_at'),
  lastRejectAt: timestamp('last_reject_at'),
  lastCancelAt: timestamp('last_cancel_at'),

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
