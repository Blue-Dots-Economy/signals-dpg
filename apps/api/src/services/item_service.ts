import { and, count, eq, sql } from 'drizzle-orm';
import {
  getDomainItemSchema,
  getDomainItemTypes,
  getInstanceCustomItemSchemaUrl,
  isLocationFieldPrivate,
  maskPrivateState,
  mergeMasksIntoPublic,
  mergeItemStateWithPrivate,
  primaryAddressChanged,
  isPrimaryAddressBlank,
  splitItemStateByPrivacy,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { classify_item } from './items/classifier.js';
import { hasAcceptedProfileConsent } from './consent_acceptance.js';
import { is_populated } from './metrics/profile_completion.js';
import { decryptPiiBlob, encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { items } from '@dpg/database';
import { user, consent_record } from '@api/db/postgres/schema';
import { db } from '@api/db/postgres/drizzle_config';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { guardianProfileConsentRow } from './guardian_consent_rows';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired, isMinor } from '@/services/minor';
import { geocodeLocationsFromState } from '@/services/geocoding/resolve_locations_for_create';
import { jitterCoordinate } from '@/services/geocoding/jitter';
import {
  buildNetworkItemSchemaUrl,
  getOrFetchSchemaByUrl,
} from '@/network_schema_cache';
import { apiConfig, getCurrentApiBaseUrl, geocodingConfig } from '@/config';

export type ItemLocation = { lat: number; lng: number; label?: string };
export function primaryLocation(locs: ItemLocation[] | null | undefined): ItemLocation | null {
  return locs && locs.length > 0 ? locs[0] : null;
}

/**
 * Order-sensitive equality of two location arrays (coords + label). Used by the
 * update path to detect a caller echoing back the already-stored (jittered)
 * coordinates, so we leave them as-is instead of jittering a jittered point.
 */
export function sameLocations(a: ItemLocation[], b: ItemLocation[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (l, i) =>
      l.lat === b[i].lat && l.lng === b[i].lng && (l.label ?? undefined) === (b[i].label ?? undefined),
  );
}

/**
 * Jitters the coordinates of a PRIVATE (PII) primary location field so the exact
 * address is never persisted: each point is offset to a deterministic random
 * spot within the configured 100–250 m annulus (see geocoding/jitter.ts). This
 * is the authoritative server-side transform — even an API caller that submits
 * an exact coordinate for a private field has it jittered here before storage.
 * Non-private location fields are returned unchanged.
 */
export function jitterPrivateLocations(
  locations: ItemLocation[],
  itemSchema: Record<string, unknown> | null | undefined,
): ItemLocation[] {
  if (locations.length === 0 || !itemSchema || !isLocationFieldPrivate(itemSchema)) {
    return locations;
  }
  return locations.map((loc) =>
    jitterCoordinate(loc, geocodingConfig.jitter_min_meters, geocodingConfig.jitter_max_meters, getPiiKey()),
  );
}

/**
 * Decides the coordinates to store for an item. NEVER geocodes — that happens in
 * the create/update paths. Here we apply the PII transform: a PRIVATE location
 * field's supplied coordinate is jittered (100–250 m) so an exact point can
 * never be persisted. Non-private fields are stored exactly as supplied.
 */
function locationsForStorage(
  provided: ItemLocation[],
  itemSchema: Record<string, unknown> | null | undefined
): ItemLocation[] {
  return jitterPrivateLocations(provided, itemSchema);
}

export class ItemServiceError extends Error {
  statusCode: number;
  errorCode: string;
  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/**
 * Whether `userId` is the creator of the item identified by the partition key.
 * Shared by the profile-consent routes (accept + U18) so the ownership query —
 * scoped on the partition-pruning columns — isn't hand-written per handler.
 */
export async function isItemOwnedBy(
  userId: string,
  ref: { network: string; item_domain: string; item_type: string; item_id: string },
  exec: DbOrTx = db,
): Promise<boolean> {
  const [owner] = await exec
    .select({ created_by: items.created_by })
    .from(items)
    .where(and(
      eq(items.item_network, ref.network),
      eq(items.item_domain, ref.item_domain),
      eq(items.item_type, ref.item_type),
      eq(items.item_id, ref.item_id),
      eq(items.created_by, userId),
    ))
    .limit(1);
  return Boolean(owner);
}

export interface CreateItemServiceParams {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state?: Record<string, unknown>;
  item_locations?: ItemLocation[];
  created_by: string;
  /**
   * Whether profile_creation consent is being accepted as part of this create
   * (the public /item/create carries a consent block). When true, a required-
   * complete item is classified `live` immediately; when false/omitted (admin/
   * bulk onboarding), the item stays `draft` and is promoted later via
   * POST /consent/profile-accept. Defaults to false.
   */
  consent_accepted?: boolean;
  /**
   * Skip the per-user profile cap (MAX_PROFILES_PER_USER / the domain's
   * `max_profiles_per_user`). Set only by trusted internal callers such as
   * seed scripts. Defaults to false — every real create path is capped.
   */
  skip_profile_limit?: boolean;
}

export interface UpdateItemServiceBody {
  item_state?: Record<string, unknown>;
  item_locations?: ItemLocation[];
}

async function resolveSchema(params: {
  item_network: string;
  item_domain: string;
  item_type: string;
  submittedItemState: Record<string, unknown>;
}) {
  const itemInstanceUrl = getCurrentApiBaseUrl();
  let itemSchemaUrl = `${itemInstanceUrl}/api/v1/network/schema/${encodeURIComponent(params.item_network)}/${encodeURIComponent(params.item_domain)}/${encodeURIComponent(params.item_type)}`;

  if (!isServedDomainBinding(params.item_network, params.item_domain)) {
    throw new ItemServiceError(
      400,
      'UNSERVED_DOMAIN',
      `Domain "${params.item_domain}" is not served by network "${params.item_network}"`
    );
  }

  let networkConfig;
  try {
    networkConfig = await getNetworkConfigById(params.item_network);
  } catch (err) {
    throw new ItemServiceError(
      400,
      'INVALID_ITEM_STATE',
      err instanceof Error ? err.message : 'Network config not found'
    );
  }

  const supportedItemTypes = getDomainItemTypes(networkConfig, params.item_domain);
  if (!supportedItemTypes.includes(params.item_type)) {
    throw new ItemServiceError(
      400,
      'INVALID_ITEM_STATE',
      `Item type "${params.item_type}" is not defined for domain "${params.item_domain}" in network "${params.item_network}".`
    );
  }

  let itemSchema: Record<string, unknown> | null = null;
  const expectedSchemaUrl = getInstanceCustomItemSchemaUrl(networkConfig, {
    domain: params.item_domain,
    instanceUrl: itemInstanceUrl,
    itemType: params.item_type,
  });

  if (expectedSchemaUrl) {
    itemSchemaUrl = expectedSchemaUrl;
    itemSchema = await getOrFetchSchemaByUrl({
      schemaUrl: expectedSchemaUrl,
      network: params.item_network,
      domain: params.item_domain,
      itemType: params.item_type,
      instanceUrl: itemInstanceUrl,
      kind: 'instance_custom_item_schema',
    });
  }

  if (!itemSchema) {
    itemSchema = getDomainItemSchema(
      networkConfig,
      params.item_domain,
      params.item_type
    );
    itemSchemaUrl =
      buildNetworkItemSchemaUrl({
        networkConfig,
        domain: params.item_domain,
        itemType: params.item_type,
      }) ?? itemSchemaUrl;
  }

  try {
    const required = Array.isArray((itemSchema as { required?: unknown }).required)
      ? ((itemSchema as { required?: string[] }).required as string[])
      : [];
    validateAgainstJsonSchema(itemSchema, params.submittedItemState, 'item_state', {
      allowAdditionalProperties: apiConfig.allow_extra_schema_data,
      ignoredKeys: required,
    });
  } catch (err) {
    throw new ItemServiceError(
      400,
      'INVALID_ITEM_STATE',
      err instanceof Error ? err.message : 'Invalid item_state'
    );
  }

  const itemState = splitItemStateByPrivacy(itemSchema, params.submittedItemState);
  return { itemSchemaUrl, itemState, itemInstanceUrl, itemSchema };
}

/**
 * Effective per-user profile cap for a (network, domain): the domain's
 * `max_profiles_per_user` when set, otherwise the global
 * `MAX_PROFILES_PER_USER` default. Returns null when no finite cap applies.
 */
async function resolveProfileLimit(
  network: string,
  domain: string,
): Promise<number | null> {
  let domainLimit: number | undefined;
  try {
    const cfg = await getNetworkConfigById(network);
    domainLimit = cfg.domains.find((d) => d.id === domain)?.max_profiles_per_user;
  } catch {
    // Fall back to the global default if the config can't be read here.
  }
  const limit = domainLimit ?? apiConfig.max_profiles_per_user;
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

/**
 * Enforce the per-user profile cap atomically, inside the caller's transaction.
 * Mirrors assertWardLimitWithLock: a transaction-scoped advisory lock keyed on
 * the (user, network, domain, item_type) scope serializes concurrent creates so
 * two racing inserts can't both pass a `count < limit` check. Throws 409
 * PROFILE_LIMIT_REACHED when the user is already at the cap.
 */
async function assertProfileLimit(
  exec: DbOrTx,
  params: Pick<
    CreateItemServiceParams,
    'created_by' | 'item_network' | 'item_domain' | 'item_type'
  >,
): Promise<void> {
  const limit = await resolveProfileLimit(params.item_network, params.item_domain);
  if (limit === null) return;

  const scope = `${params.created_by}:${params.item_network}:${params.item_domain}:${params.item_type}`;
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scope}))`);

  const [row] = await exec
    .select({ n: count() })
    .from(items)
    .where(
      and(
        eq(items.created_by, params.created_by),
        eq(items.item_network, params.item_network),
        eq(items.item_domain, params.item_domain),
        eq(items.item_type, params.item_type),
      ),
    );

  if ((row?.n ?? 0) >= limit) {
    throw new ItemServiceError(
      409,
      'PROFILE_LIMIT_REACHED',
      `This user already has the maximum of ${limit} ${params.item_domain} profile(s) allowed. Delete an existing profile to create a new one.`,
    );
  }
}

export async function createItemInternal(
  exec: DbOrTx,
  params: CreateItemServiceParams
) {
  const submittedItemState = params.item_state ?? {};
  const { itemSchemaUrl, itemState, itemInstanceUrl, itemSchema } = await resolveSchema({
    item_network: params.item_network,
    item_domain: params.item_domain,
    item_type: params.item_type,
    submittedItemState,
  });

  // Per-user profile cap (#349). Enforced at this single choke point so every
  // create path (item/create, admin/participant, aggregator bulk + reg-links)
  // inherits it. Runs on the caller's transaction for an atomic check-then-insert.
  if (!params.skip_profile_limit) {
    await assertProfileLimit(exec, params);
  }

  const masked = maskPrivateState(itemSchema, itemState.privateState);
  const itemStateForStorage = mergeMasksIntoPublic(itemState.publicState, masked);
  const encryptedPrivate =
    Object.keys(itemState.privateState).length === 0
      ? ''
      : encryptPiiBlob(JSON.stringify(itemState.privateState), getPiiKey());

  // Live requires required-complete AND profile_creation consent
  // (aggregator-dpg#464). A create that carries consent (public /item/create
  // with a consent block, passed as `consent_accepted`) IS that acceptance, so
  // it can go live now (#275). Consent-less callers (admin/bulk onboarding)
  // stay draft until POST /consent/profile-accept promotes. U18: for a gated
  // MINOR the route passes `consent_accepted=false` (self-consent must not
  // promote a minor), so they stay draft until GUARDIAN consent promotes via
  // the finalize/accept path — see create_item.ts and promoteItemOnProfileConsent.
  const classification = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: submittedItemState,
    current_status: 'draft',
    consent_accepted: params.consent_accepted ?? false,
  });

  const itemLocations = locationsForStorage(params.item_locations ?? [], itemSchema);

  const result = await exec
    .insert(items)
    .values({
      item_network: params.item_network,
      item_type: params.item_type,
      item_domain: params.item_domain,
      item_instance_url: itemInstanceUrl,
      item_schema_url: itemSchemaUrl,
      item_state: itemStateForStorage,
      item_private_state: encryptedPrivate,
      item_locations: itemLocations,
      created_by: params.created_by,
      lifecycle_status: classification.lifecycle_status,
    })
    .onConflictDoNothing({
      target: [
        items.item_network,
        items.item_domain,
        items.item_type,
        items.item_id,
      ],
    })
    .returning({
      itemNetwork: items.item_network,
      itemDomain: items.item_domain,
      itemType: items.item_type,
      itemId: items.item_id,
    });

  if (result.length === 0) {
    throw new ItemServiceError(
      409,
      'ITEM_ALREADY_EXISTS',
      'An item with the same type and id already exists'
    );
  }
  return result[0];
}

export interface UpdateItemInternalResult {
  row: {
    item_network: string;
    item_domain: string;
    item_type: string;
    item_id: string;
    item_instance_url: string;
    item_schema_url: string;
    item_state: unknown;
    item_private_state: string;
    item_locations: Array<{ lat: number; lng: number; label?: string }>;
    lifecycle_status: string;
    created_by: string;
    created_at: Date;
    updated_at: Date;
  };
}

/**
 * Server-authoritative U18 go-live gate. Returns true when an item must NOT be
 * flipped `draft → live` because a guardian-gated domain lacks the required
 * guardian consent. THE single source of truth for the age gate on every
 * promotion path (create self-consent, /consent/profile-accept, and item
 * update) — do not re-derive it inline. Fail-closed on two fronts:
 *
 *  - **null age on a gated domain → blocked.** A missing `user.age` is
 *    never treated as "adult": age capture is client-side only (u18_precheck is
 *    a hint, not a control), so a minor account with no age must not be able to
 *    self-consent to live.
 *  - **minor with no `source='guardian'` profile_creation row → blocked.** Only
 *    guardian consent promotes a minor; the ward's own self-consent row cannot.
 *
 * A proven adult (age present and not a minor), and ANY user on a non-gated
 * domain, are never blocked.
 */
export async function guardianGateBlocksGoLive(
  exec: DbOrTx,
  item: { item_network: string; item_domain: string; item_id: string; created_by: string },
): Promise<boolean> {
  const networkConfig = await getNetworkConfigById(item.item_network);
  if (!guardianConsentRequired(networkConfig, item.item_domain)) return false;

  const [ward] = await exec
    .select({ age: user.age })
    .from(user)
    .where(eq(user.id, item.created_by))
    .limit(1);

  // Cannot prove adulthood without an age → fail-closed on a gated domain.
  if (ward?.age == null) return true;
  if (!isMinor(ward.age)) return false;

  const [guardianRow] = await exec
    .select({ id: consent_record.id })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.userId, item.created_by),
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        eq(consent_record.itemId, item.item_id),
        eq(consent_record.source, 'guardian'),
      ),
    )
    .limit(1);
  return !guardianRow; // minor without guardian consent → stay draft
}

/**
 * Promote a single profile to `live` after its owner accepts `profile_creation`
 * consent (aggregator-dpg#464). A profile is created `draft` because per-item
 * consent can only be recorded after the item exists; when the owner accepts
 * profile consent (via POST /consent/profile-accept, on platform login or a
 * Voice AI call), a complete profile becomes discoverable.
 *
 * Only a `draft` item is promoted — `paused` is sticky and `live` needs no
 * change. Re-runs the same classifier used on write (with consent now true),
 * so completeness rules stay in one place. Returns true if it flipped to live.
 *
 * Caller is expected to have already recorded the consent row (and verified the
 * caller owns the item); this only re-evaluates lifecycle.
 */
export async function promoteItemOnProfileConsent(
  exec: DbOrTx,
  itemId: string
): Promise<boolean> {
  const [item] = await exec
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      lifecycle_status: items.lifecycle_status,
      created_by: items.created_by,
    })
    .from(items)
    .where(eq(items.item_id, itemId))
    .limit(1);

  if (!item || item.lifecycle_status !== 'draft') return false;

  const itemSchema = await getOrFetchSchemaByUrl({
    schemaUrl: item.item_schema_url,
    network: item.item_network,
    domain: item.item_domain,
    itemType: item.item_type,
  });

  const priv =
    item.item_private_state === ''
      ? {}
      : (JSON.parse(
          decryptPiiBlob(item.item_private_state, getPiiKey())
        ) as Record<string, unknown>);
  const mergedFullState = mergeItemStateWithPrivate(
    item.item_state as Record<string, unknown>,
    priv
  );

  const { lifecycle_status } = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: mergedFullState,
    current_status: 'draft',
    consent_accepted: true,
  });

  if (lifecycle_status !== 'live') return false;

  // U18 age gate (spec §7 / D11/D13). Fail-closed for a gated minor / null-age.
  if (await guardianGateBlocksGoLive(exec, item)) return false;

  await exec
    .update(items)
    .set({ lifecycle_status: 'live', updated_at: sql`now()` })
    .where(eq(items.item_id, itemId));
  return true;
}

/**
 * Record (or upgrade) a minor's GUARDIAN `profile_creation` consent for an item
 * and promote it live in one step. Upsert (not plain insert): a prior
 * `source='profile'` row from create_item must be upgraded to `'guardian'`, not
 * 23505'd. Shared by the U18 profile-consent verify + finalize handlers, which
 * were byte-identical. Returns whether the item was promoted to live.
 */
export async function upsertGuardianProfileConsentAndPromote(
  tx: DbOrTx,
  args: { userId: string; itemId: string; network: string; brand?: string | null; documentVersion: number },
): Promise<boolean> {
  await tx
    .insert(consent_record)
    .values(guardianProfileConsentRow(args))
    // Append a distinct source='guardian' row (the ward's own source='profile'
    // row from create_item is preserved). Conflict only on a repeat guardian
    // acceptance for the same item → idempotent update, self row untouched.
    .onConflictDoUpdate({
      target: [consent_record.userId, consent_record.itemId, consent_record.source],
      targetWhere: sql`level = 'item' AND consent_category = 'profile_creation'`,
      set: {
        documentVersion: args.documentVersion,
        acceptedAt: new Date(),
        metadata: { variant: 'u18' } as Record<string, unknown>,
      },
    });
  return promoteItemOnProfileConsent(tx, args.itemId);
}

export async function updateItemInternal(
  exec: DbOrTx,
  itemId: string,
  callerId: string,
  isAdmin: boolean,
  body: UpdateItemServiceBody
): Promise<UpdateItemInternalResult> {
  const ownershipFilter = isAdmin
    ? eq(items.item_id, itemId)
    : and(eq(items.item_id, itemId), eq(items.created_by, callerId));

  const updateValues: Record<string, unknown> = {
    updated_at: sql`now()`,
  };

  // Fetch the existing item + its schema once when either the state or the
  // locations are changing: the schema is needed to merge/validate state,
  // classify lifecycle, and coarsen a private location field.
  if (body.item_state !== undefined || body.item_locations !== undefined) {
    const [existingItem] = await exec
      .select({
        item_id: items.item_id,
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_schema_url: items.item_schema_url,
        item_state: items.item_state,
        item_private_state: items.item_private_state,
        lifecycle_status: items.lifecycle_status,
        created_by: items.created_by,
        item_locations: items.item_locations,
      })
      .from(items)
      .where(ownershipFilter)
      .limit(1);

    if (!existingItem) {
      throw new ItemServiceError(
        404,
        'ITEM_NOT_FOUND_OR_FORBIDDEN',
        'Item not found or does not belong to the authenticated user'
      );
    }

    const itemSchema = await getOrFetchSchemaByUrl({
      schemaUrl: existingItem.item_schema_url,
      network: existingItem.item_network,
      domain: existingItem.item_domain,
      itemType: existingItem.item_type,
    });

    // Full prior + merged state, hoisted so location resolution (below, after
    // the merge) can detect an address change. Populated only when item_state
    // is part of this update.
    let priorFullState: Record<string, unknown> = {};
    let mergedFullState: Record<string, unknown> = {};
    let addressChanged = false;

    if (body.item_state) {
      // Decrypt existing private blob (empty string => no prior private fields)
      // and reconstitute the full prior state (real values, not masks).
      const priorPrivate =
        existingItem.item_private_state === ''
          ? {}
          : (JSON.parse(
              decryptPiiBlob(existingItem.item_private_state, getPiiKey())
            ) as Record<string, unknown>);
      priorFullState = mergeItemStateWithPrivate(
        existingItem.item_state as Record<string, unknown>,
        priorPrivate
      );
      // Layer the caller's partial update on top.
      mergedFullState = { ...priorFullState, ...body.item_state };

      addressChanged = primaryAddressChanged(
        itemSchema as Record<string, unknown>,
        body.item_state,
        priorFullState,
      );

      const requiredKeys = Array.isArray((itemSchema as { required?: unknown }).required)
        ? ((itemSchema as { required?: string[] }).required as string[])
        : [];

      try {
        validateAgainstJsonSchema(itemSchema, mergedFullState, 'item_state', {
          allowAdditionalProperties: apiConfig.allow_extra_schema_data,
          ignoredKeys: requiredKeys,
        });
      } catch (err) {
        throw new ItemServiceError(
          400,
          'INVALID_ITEM_STATE',
          err instanceof Error ? err.message : 'Invalid item_state'
        );
      }

      // Live latch: a profile that has reached `live` must stay complete. Reject
      // any edit that would leave a required field unpopulated while the item is
      // live. (Scope: live only — see 2026-06-10-live-latch-design.md §6.)
      const unpopulatedRequired = requiredKeys.filter((k) => !is_populated(mergedFullState[k]));
      if (unpopulatedRequired.length > 0 && existingItem.lifecycle_status === 'live') {
        throw new ItemServiceError(
          409,
          'REQUIRED_FIELD_LOCKED_WHILE_LIVE',
          `Required field(s) must stay populated on a live profile: ${unpopulatedRequired.join(', ')}; pause it first`,
        );
      }

      const split = splitItemStateByPrivacy(itemSchema, mergedFullState);
      const masked = maskPrivateState(itemSchema, split.privateState);
      updateValues.item_state = mergeMasksIntoPublic(split.publicState, masked);
      updateValues.item_private_state =
        Object.keys(split.privateState).length === 0
          ? ''
          : encryptPiiBlob(JSON.stringify(split.privateState), getPiiKey());

      const consent_accepted = await hasAcceptedProfileConsent(
        exec,
        existingItem.item_id,
      );

      const classification = classify_item({
        schema: itemSchema as { required?: string[] },
        merged_state: mergedFullState,
        current_status: existingItem.lifecycle_status as 'draft' | 'live' | 'paused',
        consent_accepted,
      });
      // U18 age gate on the UPDATE path: `hasAcceptedProfileConsent` matches a
      // profile_creation row of ANY source, so a minor's create-draft-then-edit
      // would otherwise flip to `live` on their own self-consent row. Block the
      // draft→live transition through the same server gate as promote/create;
      // an already-live item is untouched (the live-latch handles those).
      const wouldGoLive =
        classification.lifecycle_status === 'live' && existingItem.lifecycle_status !== 'live';
      if (wouldGoLive && (await guardianGateBlocksGoLive(exec, existingItem))) {
        updateValues.lifecycle_status = existingItem.lifecycle_status;
      } else {
        updateValues.lifecycle_status = classification.lifecycle_status;
      }
    }

    // Location resolution precedence (runs after the state merge):
    //  1. Explicit non-empty client coords win (e.g. user picked a map
    //     suggestion). An empty `[]` is NOT explicit — it means "no coords".
    //  2. Otherwise, if the primary address field was edited (present in the
    //     partial update and changed vs prior):
    //       a. cleared to blank/empty → wipe coords (`[]`).
    //       b. non-blank → re-geocode from the merged state; only overwrite
    //          when geocoding produced something, so a geocode FAILURE
    //          preserves the existing coords rather than wiping them.
    //  3. Otherwise leave item_locations unchanged.
    const providedCoords =
      Array.isArray(body.item_locations) && body.item_locations.length > 0
        ? body.item_locations
        : null;
    if (providedCoords) {
      const stored = (existingItem.item_locations ?? []) as ItemLocation[];
      // Caller echoed back the already-stored (jittered) coords → leave as-is,
      // so a read-modify-write update never re-jitters a jittered point.
      updateValues.item_locations = sameLocations(providedCoords, stored)
        ? stored
        : locationsForStorage(providedCoords, itemSchema as Record<string, unknown>);
    } else if (addressChanged) {
      if (isPrimaryAddressBlank(itemSchema as Record<string, unknown>, mergedFullState)) {
        // Address removed — wipe coords (distinct from a geocode failure).
        updateValues.item_locations = [];
      } else {
        const geocoded = await geocodeLocationsFromState(
          itemSchema as Record<string, unknown>,
          mergedFullState
        );
        if (geocoded.length > 0) {
          updateValues.item_locations = locationsForStorage(
            geocoded,
            itemSchema as Record<string, unknown>
          );
        }
      }
    }
  }

  const updateResult = await exec
    .update(items)
    .set(updateValues)
    .where(ownershipFilter)
    .returning({
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_id: items.item_id,
      item_instance_url: items.item_instance_url,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      item_locations: items.item_locations,
      lifecycle_status: items.lifecycle_status,
      created_by: items.created_by,
      created_at: items.created_at,
      updated_at: items.updated_at,
    });

  if (updateResult.length === 0) {
    throw new ItemServiceError(
      404,
      'ITEM_NOT_FOUND_OR_FORBIDDEN',
      'Item not found or does not belong to the authenticated user'
    );
  }
  const row = updateResult[0];

  return { row };
}
