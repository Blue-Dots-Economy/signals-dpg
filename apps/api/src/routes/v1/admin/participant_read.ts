import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '../../../../db/postgres/schema/auth.js';
import { consent_record } from '@api/db/postgres/schema';
import z, {
  GetParticipantRequest as GetParticipantRequestSchema,
  GetParticipantResponse,
  type GetParticipantRequest as GetParticipantQueryType,
  type ParticipantComplianceKey,
} from '@dpg/schemas';
import { readItemsForUser, servedNetworks } from './_participant_items.js';
import { resolveConsentVersion } from '@/services/consent_version';
import { isMinor } from '@/services/minor';

/**
 * GET /api/v1/admin/participant
 *
 * Read-only lookup endpoint for both network_service and aggregator acting orgs.
 * Accepts email or phone_number (mutually optional at request level, one required
 * via schema refine). Returns user_id and items if found, filtered by org ownership.
 *
 * For network_service: returns user_id + all items if user exists.
 * For aggregator: returns user_id + items only if user was onboarded by this aggregator,
 *                otherwise returns items: [].
 * For either tier: returns { user_id: null } if user not found.
 *
 * Consent reporting:
 * - `compliance` is a `[{key, value}]` array using the same key vocabulary the
 *   POST body accepts.
 * - Every `value` is version-scoped: `true` only when a row exists at the
 *   document version this instance currently serves, so a participant on a
 *   superseded document is re-prompted.
 * - A minor is rejected with 400 `U18_NOT_ALLOWED` for `network_service`
 *   callers, never for aggregators (see the gate). An aggregator therefore does
 *   read a minor, so the comparison resolves the u18 document set; see
 *   `consentVariantForAge`.
 * - `?network=` selects which network's documents define "current"; it defaults
 *   to the served network on a single-network instance, and a value this
 *   instance does not serve is refused (`NETWORK_NOT_SERVED`) rather than
 *   answered all-false.
 *
 * Error responses are not declared in the route schema, matching the sibling
 * POST /admin/participant.
 */

type GetParticipantRequestType = FastifyRequest<{ Querystring: GetParticipantQueryType }>;

export const participant_read: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'GET',
    schema: {
      tags: ['admin'],
      querystring: GetParticipantRequestSchema,
      response: { 200: GetParticipantResponse },
    },
    handler: participant_read_handler,
  });
};

export const participant_read_handler = async (
  request: GetParticipantRequestType,
  reply: FastifyReply,
) => {
  const { email: email_norm, phone: phone_norm } = normalizeLookupIdentifier(
    request.query,
  );

  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  const orgCheck = resolveReadableActingOrg(request.acting_org);
  if (!orgCheck.ok) {
    return reply.code(orgCheck.status).send({
      error: orgCheck.error,
      message: orgCheck.message,
    });
  }
  const acting_org = orgCheck.acting_org;

  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const existingRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  const existing = existingRows[0] ?? null;

  if (!existing) {
    return reply.code(200).send({
      user_id: null,
      compliance: EMPTY_COMPLIANCE,
      items: [],
    });
  }

  // User exists — check ownership rules. An aggregator sees only the users it
  // onboarded; `network_service` can always read.
  const disclose =
    acting_org.org_type !== 'aggregator' ||
    existing.onboardedByOrgId === acting_org.org_id;

  if (!disclose) {
    // Aggregator that did not onboard this user — no consent disclosure.
    return reply.code(200).send({
      user_id: existing.id,
      compliance: EMPTY_COMPLIANCE,
      items: [],
    });
  }

  const [ageRow] = await db
    .select({ age: user.age })
    .from(user)
    .where(eq(user.id, existing.id))
    .limit(1);
  const age = ageRow?.age ?? null;

  // A minor is not readable by `network_service` callers (e.g. the voice bot):
  // the POST refuses minors for every caller, so the bot is told plainly to
  // route the user to the portal rather than "consent incomplete".
  //
  // Aggregators keep the 200: aggregator-dpg's `probeUser` reads only
  // `user_id`/`items` and treats a 400 as a hard error, which would break
  // registration for an already-onboarded minor.
  //
  // After the disclose verdict, because `U18_NOT_ALLOWED` reveals minor status.
  if (isMinorBlockedForCaller(age, acting_org.org_type)) {
    return reply.code(400).send({
      error: 'U18_NOT_ALLOWED',
      message:
        'under-18 users cannot be onboarded via this API; use the portal',
    });
  }

  // The network whose consent documents define "current".
  const networkCheck = resolveComplianceNetwork(request.query.network);
  if (!networkCheck.ok) {
    return reply.code(400).send({
      error: networkCheck.error,
      message: networkCheck.message,
    });
  }
  const network = networkCheck.network;

  const itemsList = await readItemsForUser(existing.id);
  const consentedItemIds = await readProfileConsentedItemIds(
    itemsList.map((i) => i.item_id),
    network,
    age,
  );
  const itemsWithConsent = itemsList.map((i) => ({
    ...i,
    profile_consent_accepted: consentedItemIds.has(i.item_id),
  }));
  const compliance = await readCompliance(existing.id, network, age);

  return reply.code(200).send({
    user_id: existing.id,
    compliance,
    items: itemsWithConsent,
  });
};

/**
 * Canonicalises the lookup identifier. Stored phone numbers are E.164
 * ("+91..."); callers may omit the "+", so it is prepended before the
 * exact-match lookup.
 */
function normalizeLookupIdentifier(query: GetParticipantQueryType): {
  email: string | null;
  phone: string | null;
} {
  const trimmedPhone = query.phone_number?.trim();
  let phone: string | null = null;
  if (trimmedPhone) {
    phone = trimmedPhone.startsWith('+') ? trimmedPhone : `+${trimmedPhone}`;
  }
  return { email: query.email?.trim().toLowerCase() ?? null, phone };
}

/** Acting orgs permitted to read this endpoint. */
const READABLE_ORG_TYPES = new Set(['aggregator', 'network_service']);

type ReadableActingOrg = NonNullable<GetParticipantRequestType['acting_org']>;

/**
 * Validates the acting org and narrows it to non-null. Integrating DPGs
 * (aggregator-dpg, the Raya voice bot) hold `network_service` orgs.
 */
function resolveReadableActingOrg(
  acting_org: GetParticipantRequestType['acting_org'],
):
  | { ok: true; acting_org: ReadableActingOrg }
  | { ok: false; status: number; error: string; message: string } {
  if (!acting_org) {
    return {
      ok: false,
      status: 403,
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant',
    };
  }
  if (!READABLE_ORG_TYPES.has(acting_org.org_type)) {
    return {
      ok: false,
      status: 403,
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service acting orgs are allowed',
    };
  }
  return { ok: true, acting_org };
}

/** Whether this caller must be refused because the participant is a minor; see the call site. */
function isMinorBlockedForCaller(age: number | null, orgType: string): boolean {
  if (orgType === 'aggregator') return false;
  return age != null && isMinor(age);
}

/**
 * The network to compare accepted consent versions against (`consent_config`
 * is per-network). An explicit `?network=` wins; otherwise a single served
 * network is used.
 *
 * A requested network outside the served set is refused: `resolveConsentVersion`
 * returns `null` for an unknown network, so a typo would otherwise answer a
 * confident all-`false` 200 and a voice channel would re-collect consent the
 * participant already gave.
 */
function resolveComplianceNetwork(
  requested: string | undefined,
):
  | { ok: true; network: string }
  | { ok: false; error: string; message: string } {
  const served = servedNetworks();
  // No served bindings (an unconfigured instance): nothing to check membership
  // against, so an explicitly named network is taken at its word.
  if (served.length === 0) {
    return requested
      ? { ok: true, network: requested }
      : {
          ok: false,
          error: 'NETWORK_REQUIRED',
          message:
            'this instance declares no served domains; pass ?network= to select which consent documents to compare against',
        };
  }
  if (requested) {
    if (!served.includes(requested)) {
      return {
        ok: false,
        error: 'NETWORK_NOT_SERVED',
        message: `this instance does not serve network "${requested}"`,
      };
    }
    return { ok: true, network: requested };
  }
  if (served.length === 1) return { ok: true, network: served[0] };
  return {
    ok: false,
    error: 'NETWORK_REQUIRED',
    message:
      'this instance serves more than one network; pass ?network= to select which consent documents to compare against',
  };
}

/**
 * The document set a participant's rows were written against. A ward's rows are
 * written with `variant: 'u18'` against `u18_documents`, which has its own
 * `current_version` per category, so comparing them to the adult counter would
 * report a guardian-completed ward as un-consented.
 *
 * `age == null` resolves to `'adult'`. A mismatch is safe either way: it yields
 * `false`, which re-prompts rather than claiming unverified consent.
 */
function consentVariantForAge(age: number | null): 'adult' | 'u18' {
  return age != null && isMinor(age) ? 'u18' : 'adult';
}

/**
 * Cache key for one resolved document version: category + the row's brand
 * (null = network default). NUL-joined so no brand can collide with a category.
 */
function versionKey(category: string, brand: string | null): string {
  return `${category}\u0000${brand ?? ''}`;
}

/**
 * Resolves the current version for each distinct (category, brand) pair.
 * Returns `versionKey` → current version, or null when unconfigured.
 */
async function resolveVersionsFor(
  pairs: Array<{ category: string; brand: string | null }>,
  network: string,
  variant: 'adult' | 'u18',
): Promise<Map<string, number | null>> {
  const wanted = new Map<string, { category: string; brand: string | null }>();
  for (const p of pairs) wanted.set(versionKey(p.category, p.brand), p);
  const resolved = await Promise.all(
    [...wanted].map(
      async ([key, p]) =>
        [
          key,
          await resolveConsentVersion({
            network,
            brand: p.brand,
            category: p.category as Parameters<
              typeof resolveConsentVersion
            >[0]['category'],
            variant,
          }),
        ] as const,
    ),
  );
  return new Map(resolved);
}

/**
 * User-level compliance: whether a consent row exists at the version this
 * instance currently serves. The response carries no version, so the caller
 * cannot detect a superseded acceptance itself.
 *
 * Each row is compared against the current version for its own stored `brand`,
 * not the network default: `resolveConsentVersion` prefers a brand override and
 * the write side records the brand, so resolving only the default would report
 * a brand cohort as consented after the brand bumped its terms.
 *
 * @returns One entry per reported key, every key always present.
 */
async function readCompliance(
  userId: string,
  network: string,
  age: number | null,
): Promise<Array<{ key: ParticipantComplianceKey; value: boolean }>> {
  const variant = consentVariantForAge(age);

  // Network-scoped: a row accepted on another network cannot satisfy this
  // network's document.
  const rows = await db
    .select({
      category: consent_record.consentCategory,
      version: consent_record.documentVersion,
      brand: consent_record.brand,
    })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.userId, userId),
        eq(consent_record.level, 'user'),
        eq(consent_record.network, network),
        inArray(consent_record.consentCategory, ['terms', 'privacy']),
      ),
    );

  const currentFor = await resolveVersionsFor(
    rows.map((r) => ({ category: r.category, brand: r.brand ?? null })),
    network,
    variant,
  );

  // An unconfigured category resolves to `null` and is reported `false`, so the
  // caller goes to a consent flow rather than proceeding on an unverifiable claim.
  const acceptedAt = (category: 'terms' | 'privacy'): boolean =>
    rows.some((r) => {
      if (r.category !== category) return false;
      const current = currentFor.get(versionKey(r.category, r.brand ?? null));
      return current != null && r.version === current;
    });

  return [
    { key: 'user_terms', value: acceptedAt('terms') },
    { key: 'user_privacy', value: acceptedAt('privacy') },
    { key: 'has_age', value: age != null },
  ];
}

/**
 * Item ids whose `profile_creation` consent is accepted at the current version,
 * with the same network and per-row brand rules as `readCompliance`. Drives
 * `ParticipantItemSnapshot.profile_consent_accepted`.
 */
async function readProfileConsentedItemIds(
  itemIds: string[],
  network: string,
  age: number | null,
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set<string>();
  const variant = consentVariantForAge(age);
  const rows = await db
    .select({
      itemId: consent_record.itemId,
      version: consent_record.documentVersion,
      brand: consent_record.brand,
    })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        eq(consent_record.network, network),
        inArray(consent_record.itemId, itemIds),
      ),
    );

  const currentFor = await resolveVersionsFor(
    rows.map((r) => ({ category: 'profile_creation', brand: r.brand ?? null })),
    network,
    variant,
  );

  const consented = new Set<string>();
  for (const r of rows) {
    const current = currentFor.get(versionKey('profile_creation', r.brand ?? null));
    if (current != null && r.version === current && r.itemId) {
      consented.add(r.itemId);
    }
  }
  return consented;
}

/**
 * Reported when there is nothing to disclose (user not found, or an aggregator
 * that did not onboard them). Every key is present and `false`, so both
 * branches are indistinguishable from "nothing accepted".
 */
const EMPTY_COMPLIANCE: Array<{ key: ParticipantComplianceKey; value: boolean }> = [
  { key: 'user_terms', value: false },
  { key: 'user_privacy', value: false },
  { key: 'has_age', value: false },
];

export default participant_read;
