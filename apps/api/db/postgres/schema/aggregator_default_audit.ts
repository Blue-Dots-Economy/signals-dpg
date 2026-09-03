import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Append-only audit of default-aggregator changes via
 * POST /api/v1/admin/aggregator/default (#640, SS-3). One row per binding
 * actually changed. No updates, no deletes wired up — same shape as
 * `pii_reveal_audit`.
 *
 * Why this table exists at all: `organization` has no `updated_at`, and the
 * default is stored as a plain column, so without this there would be **no
 * trace of when a default changed** — and the default decides which
 * organisation may decrypt an entire inbound population's PII. The later
 * re-assignment job needs to know when the hand-over happened; it cannot be
 * reconstructed after the fact.
 *
 * No FK on `changed_by`: the acting service user may be removed later and the
 * audit row must survive it. `from_org_id` / `to_org_id` are likewise
 * unconstrained so an org row can be deleted without erasing history.
 */
export const aggregator_default_audit = pgTable(
  'aggregator_default_audit',
  {
    changeId: uuid('change_id').primaryKey().defaultRandom(),
    /** Canonical served-domain binding, e.g. 'blue_dot/seeker'. */
    binding: text('binding').notNull(),
    /** Null on the first assignment for this binding. */
    fromOrgId: text('from_org_id'),
    /**
     * Null when the binding was REVOKED — the org stood down and nothing took
     * over. Nullable on purpose: `bindings: []` is the documented way to stand
     * an aggregator down, and a NOT NULL column could not represent it, so the
     * single most consequential operation the endpoint supports would have gone
     * unaudited.
     */
    toOrgId: text('to_org_id'),
    /** The acting network-service user that made the change. */
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at').notNull().defaultNow(),
  },
  (table) => [
    index('aggregator_default_audit_binding_idx').on(table.binding, table.changedAt),
    index('aggregator_default_audit_to_org_idx').on(table.toOrgId, table.changedAt),
  ]
);
