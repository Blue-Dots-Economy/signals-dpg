import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Append-only audit of participant ownership re-assignments (#640 / SS-3
 * follow-up). One row per user moved between aggregators. No updates, no
 * deletes wired up — same shape as `pii_reveal_audit`.
 *
 * `user.onboarded_by_org_id` is the tenancy key for participant reads, action
 * authorisation and **PII decryption**, so moving it is a transfer of PII
 * access between organisations, not a relabel. The column is otherwise
 * write-once, so every row here represents a deliberate, operator-initiated
 * hand-over — and it is the only record of which organisation could decrypt a
 * given participant during which period.
 *
 * No FKs: an org or user row may later be removed and this history must
 * survive it.
 */
export const participant_reassignment_audit = pgTable(
  'participant_reassignment_audit',
  {
    reassignmentId: uuid('reassignment_id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    /** Null when the participant was previously untagged (a backfill). */
    fromOrgId: text('from_org_id'),
    toOrgId: text('to_org_id').notNull(),
    /** Canonical served-domain binding the move was scoped to, e.g. 'blue_dot/seeker'. */
    binding: text('binding').notNull(),
    /** Why the move happened, e.g. 'default_change' | 'pre_default_backfill'. */
    reason: text('reason').notNull(),
    /** The operator or service identity that initiated it. */
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at').notNull().defaultNow(),
  },
  (table) => [
    index('participant_reassignment_audit_user_idx').on(table.userId, table.changedAt),
    index('participant_reassignment_audit_from_idx').on(table.fromOrgId, table.changedAt),
    index('participant_reassignment_audit_to_idx').on(table.toOrgId, table.changedAt),
  ]
);
