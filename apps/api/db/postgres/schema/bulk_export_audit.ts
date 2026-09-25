import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per bulk engagement export (`POST /api/v1/action/export`, #770).
 *
 * Metadata only (#639 Q5): who exported, what they asked for, and how many
 * rows were revealed / masked / skipped — never the exported values. The
 * download's `X-Export-Id` header and filename carry `export_id`, so any file
 * found later traces back to exactly one row here. `filters` / `projection`
 * are stored as received (jsonb) so new filters need no migration.
 */
export const bulk_export_audit = pgTable(
  'bulk_export_audit',
  {
    exportId: uuid('export_id').primaryKey(),
    requesterUserId: text('requester_user_id').notNull(),
    requesterItemId: uuid('requester_item_id'),
    filters: jsonb('filters').notNull(),
    projection: jsonb('projection').notNull(),
    format: text('format').notNull(),
    rowCount: integer('row_count').notNull(),
    revealedCount: integer('revealed_count').notNull(),
    maskedCount: integer('masked_count').notNull(),
    skippedCrossInstance: integer('skipped_cross_instance').notNull(),
    skippedMissing: integer('skipped_missing').notNull(),
    skippedSelf: integer('skipped_self').notNull(),
    skippedNotEnabled: integer('skipped_not_enabled').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('bulk_export_audit_requester_idx').on(table.requesterUserId, table.createdAt),
  ]
);
