import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  jsonb,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text('role'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  phoneNumber: text('phone_number').unique(),
  phoneNumberVerified: boolean('phone_number_verified'),
  // Age (years) captured at registration for U18 gating. Snapshot, not
  // a birthdate — a minor is age <= 18 (the boundary year is treated as u18,
  // no month). Optional. `location` is an optional free-text account location.
  age: integer('age'),
  location: text('location'),
  // Domain roles the user signed up for / is allowed to create profiles in
  // (e.g. ['seeker'] now; ['seeker','provider'] once multi-role is enabled).
  // Persisted at signup; profile creation is restricted to these. Null/empty
  // for users onboarded before this existed — callers fall back to held items.
  domains: text('domains').array(),
  termsAccepted: boolean('terms_accepted').default(false),
  privacyAccepted: boolean('privacy_accepted').default(false),
  // The owning aggregator. Set by POST /api/v1/admin/participant (the acting
  // aggregator, or the default aggregator for a network_service caller) and by
  // default-aggregator tagging (`tagUserWithDefaultAggregator`). Null when no
  // aggregator owns the user. Grants PII-decrypt rights.
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  // True when `onboarded_by_org_id` came from the default aggregator rather
  // than a real onboarding act. Server-only, never derived from
  // `onboarded_via` (which comes from the caller's `channel` field), because
  // the re-assignment job scopes on it to hand out PII-decrypt rights.
  onboardedByDefault: boolean('onboarded_by_default').notNull().default(false),
  onboardedVia: text('onboarded_via'),
  onboardedSourceId: text('onboarded_source_id'),
  onboardedAt: timestamp('onboarded_at'),
  // Extensible support/ops markers on the user. Keyed jsonb so new flags can
  // be added without a migration. Current keys: `is_test` (boolean) — marks a
  // user (and, by the created_by/owner join, their profiles, posts, and
  // applications) as test data for analysis + later bulk cleanup;
  // `app_first_login_at` (ISO string) — first browser login to the app, see
  // services/auth/app_first_login.ts.
  tags: jsonb('tags').notNull().default({}),
}, (table) => [
  index('user_onboarded_by_org_via_idx').on(
    table.onboardedByOrgId,
    table.onboardedVia,
  ),
  // GIN index accelerates `tags @> '{"is_test": true}'` containment lookups.
  index('user_tags_gin_idx').using('gin', table.tags),
]);

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull(),
  metadata: text('metadata'),
  type: text('type'),
  // Served-domain bindings ("<network>/<domain>", e.g.
  // 'blue_dot/seeker') for which this org is the DEFAULT aggregator — the one
  // that inherits users arriving with no aggregator of their own.
  //
  // An array because one aggregator may be the default for several domains
  // (seeker AND provider is the expected launch shape). Postgres cannot
  // unique-index an array element, so "one org per binding" is enforced by the
  // `organization_default_binding_exclusive` trigger (migration 0014), which
  // rejects a nomination for a binding another org already holds.
  //
  // Not indexed: `organization` holds tens to hundreds of rows, where a
  // sequential scan beats GIN and GIN would tax every upsert.
  defaultForBindings: text('default_for_bindings').array(),
}, (table) => [
  // The flag grants PII-decrypt rights over the users it captures, so it must
  // never land on a `network_service` org. Approval state lives in
  // aggregator-dpg, so this constraint is the only half enforceable here.
  check(
    'organization_default_requires_aggregator',
    sql`${table.defaultForBindings} IS NULL OR ${table.type} = 'aggregator'`,
  ),
  // `type` is plain text, so this constraint moves an invalid value's failure
  // to the INSERT instead of a later `403 ACTING_ORG_TYPE_NOT_ALLOWED`. NULL
  // stays permitted for pre-existing rows (the acting-org preHandler refuses
  // it). Adding a value is a migration on purpose: an org type is an
  // authorization tier, and `_resolve_acting_actor.ts` must learn its reach in
  // the same change.
  check(
    'organization_type_allowed',
    sql`${table.type} IS NULL OR ${table.type} IN ('aggregator', 'network_service')`,
  ),
  // Several orgs may hold defaults, one per binding. That is safe because the
  // single-domain lock (`claimDomain`, `services/items/single_domain_lock.ts`)
  // keeps each account, whose `onboarded_by_org_id` grants PII-decrypt rights,
  // to one domain. Per-binding exclusivity is enforced by the
  // `organization_default_binding_exclusive` trigger (migration 0014), since
  // Postgres cannot unique-index an array element.
]);

export const member = pgTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').default('member').notNull(),
  teamId: text('team_id'),
  createdAt: timestamp('created_at').notNull(),
});

export const apikey = pgTable('apikey', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull().default('default'),
  name: text('name'),
  // First raw-key chars, for display only. The raw key is never stored.
  start: text('start'),
  referenceId: text('reference_id').notNull(),
  prefix: text('prefix'),
  // SHA-256(raw_key) base64url-encoded without padding (43 chars), as
  // `hashApiKey` in plugins/auth/verify_api_key.ts computes it. Never store the
  // raw key; see apps/api/scripts/seed_service_users.ts for minting.
  key: text('key').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  refillInterval: integer('refill_interval'),
  refillAmount: integer('refill_amount'),
  lastRefillAt: timestamp('last_refill_at'),
  enabled: boolean('enabled').default(true),
  rateLimitEnabled: boolean('rate_limit_enabled').default(true),
  rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
  rateLimitMax: integer('rate_limit_max').default(10),
  requestCount: integer('request_count'),
  remaining: integer('remaining'),
  lastRequest: timestamp('last_request'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  permissions: text('permissions'),
  metadata: text('metadata'),
});
