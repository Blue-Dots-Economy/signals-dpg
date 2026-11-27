import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import {
  DecryptParticipantRequest as DecryptParticipantRequestSchema,
  DecryptParticipantResponse,
  type DecryptParticipantRequest as DecryptParticipantRequestType,
  type DecryptedProfileSnapshot,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { readConfiguredDomains } from '@/utils/org_metadata';
import { ITEMS_NEWEST_FIRST, servedNetworks } from './_participant_items.js';
import { getNetworkConfigById } from '@/network_configs';
import {
  projectItemState,
  resolveContact,
  normalizeContact,
  resolveNameFallbackField,
  type CanonicalContact,
  type DomainConfigForName,
  type DomainContactContext,
} from '@/utils/contact_fields';

/**
 * POST /api/v1/admin/participant/decrypt
 *
 * Returns decrypted profile item_state for a set of item_ids or a user_id.
 * Ownership is keyed on the item creator's `user.onboarded_by_org_id`, never on
 * the lazily materialised `item_metrics` cache.
 *  - aggregator: only items whose creator it onboarded, in its declared domains.
 *  - network_service: all items in served networks.
 * Requested ids that are not found / not in a served network / not owned / fail
 * to decrypt land in `skipped` with no distinction (no existence leak).
 *
 * Design: docs/architecture/http-participant-decrypt-scope.md
 */

type DecryptRequestType = FastifyRequest<{ Body: DecryptParticipantRequestType }>;

export const participant_decrypt: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant/decrypt',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: DecryptParticipantRequestSchema,
      response: { 200: DecryptParticipantResponse },
    },
    handler: participant_decrypt_handler,
  });
};

// Base columns. `item_locations` and the creator's account contact are added
// only when requested, so the default path never pulls account PII.
const ITEM_COLUMNS_BASE = {
  item_id: items.item_id,
  item_network: items.item_network,
  item_domain: items.item_domain,
  item_type: items.item_type,
  item_state: items.item_state,
  item_private_state: items.item_private_state,
  created_at: items.created_at,
  updated_at: items.updated_at,
} as const;

/**
 * The SELECT columns for one request: `item_locations` only when
 * `include_locations`; the creator's account name/email/phone (the `contact`
 * fallback source) only when `contact` is requested.
 */
function buildSelectColumns(opts: SnapshotOptions) {
  return {
    ...ITEM_COLUMNS_BASE,
    ...(opts.includeLocations ? { item_locations: items.item_locations } : {}),
    ...(opts.contact
      ? { user_name: user.name, user_email: user.email, user_phone: user.phoneNumber }
      : {}),
  };
}

type DecryptableRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: unknown;
  item_private_state: string;
  created_at: Date;
  updated_at: Date;
  // Present only when requested; see buildSelectColumns.
  item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  user_name?: string | null;
  user_email?: string | null;
  user_phone?: string | null;
};

/**
 * Decrypts one row's private blob, isolating failures: a corrupt or
 * wrong-key `item_private_state` returns null (the id is reported as
 * skipped) instead of throwing and 500-ing the whole batch.
 */
const decryptRowSafe = (
  r: DecryptableRow,
  log: FastifyRequest['log'],
): Record<string, unknown> | null => {
  try {
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return mergedState;
  } catch (err) {
    log.error(
      { operation: 'admin.participant.decrypt.row_failed', item_id: r.item_id, err },
      'failed to decrypt item_private_state; excluding item from results',
    );
    return null;
  }
};

/**
 * Resolves the per-row domain contact-field context (name fallback =
 * item-type display_name_field, then domain card.title_field).
 *
 * Failure-isolated like `decryptRowSafe`: a config lookup failure degrades this
 * row to an empty context (account contact for every requested field) instead
 * of 500-ing the batch. `getNetworkConfigById` is process-memoized, so no
 * per-request cache is needed.
 */
async function resolveDomainContext(
  r: DecryptableRow,
  log: FastifyRequest['log'],
): Promise<DomainContactContext> {
  const base: DomainContactContext = {
    network: r.item_network,
    domain: r.item_domain,
    itemType: r.item_type,
  };
  let cfg;
  try {
    cfg = await getNetworkConfigById(r.item_network);
  } catch (err) {
    log.error(
      {
        operation: 'admin.participant.decrypt.config_lookup_failed',
        network: r.item_network,
        domain: r.item_domain,
        err,
      },
      'failed to resolve network config for contact resolution; falling back to empty context (account contact)',
    );
    return base;
  }
  const domainCfg = cfg.domains.find((d) => d.id === r.item_domain);
  const nameFallbackField = resolveNameFallbackField(
    domainCfg as DomainConfigForName | undefined,
    r.item_type,
  );
  return {
    ...base,
    contactFields: domainCfg?.contact_fields,
    ...(nameFallbackField ? { nameFallbackField } : {}),
  };
}

/** Clamps a stored (possibly jitter-nudged) coordinate into the WGS84 range so
 * the validating response serializer cannot 500 the batch on one point. */
function clampLocation(loc: { lat: number; lng: number; label?: string }): {
  lat: number;
  lng: number;
  label?: string;
} {
  return {
    lat: Math.max(-90, Math.min(90, loc.lat)),
    lng: Math.max(-180, Math.min(180, loc.lng)),
    ...(loc.label !== undefined ? { label: loc.label } : {}),
  };
}

/** Per-request options for the three independent, optional controls. */
interface SnapshotOptions {
  fields: string[] | undefined;
  contact: CanonicalContact[] | undefined; // already normalized (true => all three)
  includeLocations: boolean;
}

/**
 * Builds one profile snapshot from a decrypted row: `item_state` is the full
 * merged state or, when `fields` is requested, a pure projection of it.
 * `contact` and `locations` are attached independently of `fields`.
 */
async function buildSnapshot(
  r: DecryptableRow,
  mergedState: Record<string, unknown>,
  opts: SnapshotOptions,
  log: FastifyRequest['log'],
): Promise<DecryptedProfileSnapshot> {
  const snapshot: DecryptedProfileSnapshot = {
    item_id: r.item_id,
    item_network: r.item_network,
    item_domain: r.item_domain,
    item_type: r.item_type,
    item_state: opts.fields ? projectItemState(mergedState, opts.fields) : mergedState,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
  if (opts.contact) {
    snapshot.contact = resolveContact(
      mergedState,
      { name: r.user_name ?? null, email: r.user_email ?? null, phone: r.user_phone ?? null },
      opts.contact,
      await resolveDomainContext(r, log),
      log,
    );
  }
  if (opts.includeLocations) {
    snapshot.locations = (r.item_locations ?? []).map(clampLocation);
  }
  return snapshot;
}

/**
 * Decrypts every row and builds its snapshot, splitting rows into `profiles`
 * and `failedIds` (decrypt failed). item_ids mode derives `skipped` from the
 * requested ids missing from `profiles`; user_id mode uses `failedIds`.
 */
async function collectProfiles(
  rows: DecryptableRow[],
  opts: SnapshotOptions,
  log: FastifyRequest['log'],
): Promise<{ profiles: DecryptedProfileSnapshot[]; failedIds: string[] }> {
  const profiles: DecryptedProfileSnapshot[] = [];
  const failedIds: string[] = [];
  for (const r of rows) {
    const mergedState = decryptRowSafe(r, log);
    if (mergedState) {
      profiles.push(await buildSnapshot(r, mergedState, opts, log));
    } else {
      failedIds.push(r.item_id);
    }
  }
  return { profiles, failedIds };
}

/**
 * Tallies account-fallback disclosures for the audit log: contact fields served
 * from the login-identity account (`source: 'user'`) and across how many
 * profiles. A distinct disclosure class, so it is recorded separately.
 */
function countAccountFallback(profiles: DecryptedProfileSnapshot[]): {
  fields: number;
  profiles: number;
} {
  let fields = 0;
  let profilesWithFallback = 0;
  for (const p of profiles) {
    if (!p.contact) continue;
    const used = Object.values(p.contact).filter((c) => c?.source === 'user').length;
    if (used > 0) {
      fields += used;
      profilesWithFallback += 1;
    }
  }
  return { fields, profiles: profilesWithFallback };
}

/**
 * Ownership/served-network scoping shared by both query modes. Aggregators are
 * restricted to items whose creator they onboarded and to their declared
 * `metadata.domains` (defence in depth against an account spanning two
 * domains). The domain scope is read live, so narrowing an org's domains
 * revokes decrypt for participants it already onboarded.
 *
 * Design: docs/architecture/http-participant-decrypt-scope.md
 */
function scopeConditions(
  isAgg: boolean,
  actingOrgId: string,
  networks: string[],
  domains: string[],
) {
  return [
    networks.length > 0 ? inArray(items.item_network, networks) : undefined,
    isAgg ? eq(user.onboardedByOrgId, actingOrgId) : undefined,
    isAgg ? inArray(items.item_domain, domains) : undefined,
  ] as const;
}

export const participant_decrypt_handler = async (
  request: DecryptRequestType,
  reply: FastifyReply,
) => {
  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant/decrypt',
    });
  }
  const acting = request.acting_org;
  if (acting.org_type !== 'aggregator' && acting.org_type !== 'network_service') {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service acting orgs are allowed',
    });
  }

  const isAgg = acting.org_type === 'aggregator';
  const networks = servedNetworks();

  // Fail closed on an aggregator that declares no domains: defaulting to "all"
  // on a PII-decrypt path is the wrong direction. Same refusal as
  // `aggregator/export.ts`.
  const domains = isAgg ? await readConfiguredDomains(acting.org_id) : [];
  if (isAgg && domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }
  const body = request.body;
  const fields = body.fields;
  const contact = normalizeContact(body.contact);
  const opts: SnapshotOptions = {
    fields,
    contact,
    includeLocations: body.include_locations === true,
  };
  const selectColumns = buildSelectColumns(opts);

  let profiles: DecryptedProfileSnapshot[];
  let skipped: string[];
  let mode: 'item_ids' | 'user_id';

  if (body.item_ids) {
    mode = 'item_ids';
    const requested = Array.from(new Set(body.item_ids));
    const rows = (await db
      .select(selectColumns)
      .from(items)
      .innerJoin(user, eq(user.id, items.created_by))
      .where(
        and(
          inArray(items.item_id, requested),
          ...scopeConditions(isAgg, acting.org_id, networks, domains),
        ),
      )) as DecryptableRow[];

    ({ profiles } = await collectProfiles(rows, opts, request.log));
    // Not found, not owned, not in a served network, OR failed to decrypt — all
    // land in skipped, undifferentiated, so the response never leaks existence.
    const found = new Set(profiles.map((p) => p.item_id));
    skipped = requested.filter((id) => !found.has(id));
  } else {
    mode = 'user_id';
    const userId = body.user_id!;
    const rows = (await db
      .select(selectColumns)
      .from(items)
      .innerJoin(user, eq(user.id, items.created_by))
      .where(
        and(
          eq(items.created_by, userId),
          ...scopeConditions(isAgg, acting.org_id, networks, domains),
        ),
      )
      // Shares the ORDER BY with `readItemsForUser` so the participant routes
      // list items in the same order.
      .orderBy(...ITEMS_NEWEST_FIRST)) as DecryptableRow[];

    const collected = await collectProfiles(rows, opts, request.log);
    profiles = collected.profiles;
    skipped = collected.failedIds;
  }

  // Audit: every call returns decrypted PII, so every call is recorded. Counts
  // only; never log item_state values.
  const accountFallback = countAccountFallback(profiles);
  request.log.info({
    operation: 'admin.participant.decrypt',
    acting_org_id: acting.org_id,
    org_type: acting.org_type,
    mode,
    requested_count: body.item_ids ? new Set(body.item_ids).size : 1,
    returned_count: profiles.length,
    skipped_count: skipped.length,
    fields_requested: fields?.length,
    contact_requested: contact?.length,
    include_locations: opts.includeLocations,
    account_fallback_fields: accountFallback.fields,
    account_fallback_profiles: accountFallback.profiles,
  });

  return reply.code(200).send({ profiles, skipped });
};

export default participant_decrypt;
