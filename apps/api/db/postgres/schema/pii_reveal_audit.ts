import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Append-only audit of PII reveals via GET /api/v1/action/:action_id/contact-details.
 * One row per successful 2xx response. No updates, no deletes wired up.
 *
 * No FK to item_actions or items — both are partitioned and a single-column FK
 * isn't possible. App-level integrity: the handler always reads the action and
 * item rows before inserting.
 */
export const pii_reveal_audit = pgTable(
  'pii_reveal_audit',
  {
    revealId: uuid('reveal_id').primaryKey().defaultRandom(),
    actionId: uuid('action_id').notNull(),
    viewerUserId: text('viewer_user_id').notNull(),
    revealedItemId: uuid('revealed_item_id').notNull(),
    revealedItemOwner: text('revealed_item_owner').notNull(),
    revealedActionType: text('revealed_action_type').notNull(),
    revealedActionStatusAtView: text('revealed_action_status_at_view').notNull(),
    viewedAt: timestamp('viewed_at').notNull().defaultNow(),
  },
  (table) => [
    index('pii_reveal_audit_viewer_idx').on(table.viewerUserId, table.viewedAt),
    index('pii_reveal_audit_item_idx').on(table.revealedItemId, table.viewedAt),
  ]
);
