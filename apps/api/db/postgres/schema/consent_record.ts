import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  bigserial,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Append-only consent ledger (spec 2026-06-30 minimal v1). One row per consent
 * event. Latest event per (subject, type) wins by `seq`, never by timestamp.
 *
 * Levels: `user` (terms/privacy — keyed on user_id) and `item`
 * (profile_creation + action — keyed on item_id, plus action_id for actions).
 * No FK to items/item_actions — both are partitioned; app-level integrity only.
 * Content is NOT stored; it is resolved from consent.json by (type, version).
 */
export const consent_record = pgTable(
  'consent_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    level: text('level').notNull(), // 'user' | 'item'
    consentCategory: text('consent_category').notNull(), // terms|privacy|profile_creation|action
    actionType: text('action_type'), // only for 'action' (e.g. connect, apply)
    actionStage: text('action_stage'), // only for 'action': 'initiate' | 'accept'
    userId: text('user_id').notNull(),
    itemId: uuid('item_id'), // set for item-level rows
    actionId: uuid('action_id'), // set for action rows
    network: text('network').notNull(),
    brand: text('brand'), // which brand variant applied (client-supplied)
    documentVersion: integer('document_version').notNull(),
    source: text('source').notNull(), // signup|login|profile|action
    acceptedAt: timestamp('accepted_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('consent_record_user_idx').on(
      table.userId,
      table.consentCategory,
      table.actionType,
      table.actionStage,
      table.seq
    ),
    index('consent_record_item_idx').on(table.itemId, table.consentCategory),
    index('consent_record_action_idx').on(table.actionId),
    // Item-level profile_creation is idempotent — at most one acceptance per
    // (user, item). Makes the accept-profile-consent 23505 fallback live and
    // blocks concurrent double-submit. Terms/privacy/action stay append-only,
    // so this unique index is partial.
    uniqueIndex('consent_record_profile_creation_unique')
      .on(table.userId, table.itemId)
      .where(sql`level = 'item' AND consent_category = 'profile_creation'`),
  ]
);
