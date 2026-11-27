import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Append-only audit of default-aggregator changes. Written by the
 * `organization_default_aggregator_audit` trigger (migration 0014), one row per
 * binding gained or lost. No updates or deletes are wired up.
 *
 * `organization` has no `updated_at`, and the default decides which org may
 * decrypt an inbound population's PII, so this is the only record of when a
 * default changed. A trigger rather than app code because defaults are
 * nominated by hand-written UPDATEs (support requests) that no route sees.
 *
 * A hand-over lands as two rows, because exclusivity forces clearing org A
 * before setting org B: a revoke (`to_org_id` null) and a grant (`from_org_id`
 * null), the grant shaped like a first-ever nomination. Run both UPDATEs in one
 * transaction so the pair shares a `changed_at` for correlation.
 *
 * `changed_by` is the Postgres role that ran the statement. If support connects
 * through one shared role, every change reads identically — the row says WHEN
 * and WHAT, not which human. Add a session-level audit context if per-operator
 * attribution is needed.
 *
 * No FK on `changed_by`: the role may be dropped later and the audit row must
 * survive it. `from_org_id` / `to_org_id` are likewise
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
     * Null when the binding was revoked (the org stood down and nothing took
     * over), e.g. via `bindings: []`.
     */
    toOrgId: text('to_org_id'),
    /** The Postgres role that ran the statement. */
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at').notNull().defaultNow(),
  },
  (table) => [
    index('aggregator_default_audit_binding_idx').on(table.binding, table.changedAt),
    index('aggregator_default_audit_to_org_idx').on(table.toOrgId, table.changedAt),
  ]
);
