import { pgTable, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

/**
 * Item-keyed metrics for the aggregator dashboard.
 *
 * Each item gets one row. Action data is split by DIRECTION: `initiated`
 * (item was the source of the action) vs `received` (item was the target),
 * each a jsonb map over the 4 canonical buckets (create / accept / reject /
 * cancel). `last_initiated_at` / `last_received_at` are sparse jsonb maps —
 * only buckets that occurred carry an ISO timestamp. display_name is resolved
 * at recompute time from the item's schema-declared display_name_field (or
 * item_id as fallback).
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

  // Directional action counts — full maps over the 4 canonical buckets.
  initiated: jsonb('initiated').$type<Record<string, number>>().default({}).notNull(),
  received: jsonb('received').$type<Record<string, number>>().default({}).notNull(),

  // Most-recent action timestamp per bucket, per direction — SPARSE: only
  // buckets that occurred are present (ISO strings).
  lastInitiatedAt: jsonb('last_initiated_at').$type<Record<string, string>>().default({}).notNull(),
  lastReceivedAt: jsonb('last_received_at').$type<Record<string, string>>().default({}).notNull(),

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
