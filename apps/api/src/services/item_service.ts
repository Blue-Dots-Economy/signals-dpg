import { and, count, eq, ne, sql } from 'drizzle-orm';
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
  JsonSchemaValidationError,
} from '@dpg/schemas';
import { classify_item, DEFAULT_GO_LIVE_GATES, type GoLiveGate } from './items/classifier.js';
import type { DbOrTx } from '@/services/db_types';
import {
  claimDomain,
  domainLockedMessage,
  readLockedDomains,
} from './items/single_domain_lock.js';
import {
  resolveOwnerGateContext,
  type OwnerGateContext,
} from './aggregator/default_aggregator.js';
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
import { findLocationOutsideCountry } from '@/services/geocoding/country_boundary';
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
 * Order-sensitive equality of two location arrays (coords + label). The update
 * path uses it to detect echoed-back stored (already jittered) coordinates, so
 * they are not jittered twice.
 */
export function sameLocations(a: ItemLocation[], b: ItemLocation[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (l, i) =>
      l.lat === b[i].lat && l.lng === b[i].lng && (l.label ?? undefined) === (b[i].label ?? undefined),
  );
}

/**
 * Jitters the coordinates of a private (PII) primary location field so the
 * exact address is never persisted: each point moves to a deterministic spot in
 * the configured annulus (default 100–250 m, see geocoding/jitter.ts). This is
 * the authoritative server-side transform, so exact coordinates from any API
 * caller are jittered before storage. Non-private fields are returned unchanged.
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
 * The coordinates to store for an item: private location fields are jittered,
 * others are stored as supplied. Does not geocode; the create/update paths do.
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
  /**
   * Extra machine-readable fields merged into the route's error body, e.g.
   * `locked_domain` / `requested_domain` on DOMAIN_LOCKED or `fields` on
   * INVALID_ITEM_STATE. These are part of the published error contract for
   * external clients even where the in-repo UI does not read them.
   */
  details?: Record<string, unknown>;
  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export type { DbOrTx } from '@/services/db_types';

/**
 * A schema failure on `item_state` as the 400 every item write returns. Carries
 * the validator's per-field map as `fields` (merged into the route's error
 * body), so a caller can point at the offending input without parsing the
 * message — a bulk CSV column, a form field.
 */
function invalidItemStateError(err: unknown): ItemServiceError {
  return new ItemServiceError(
    400,
    'INVALID_ITEM_STATE',
    err instanceof Error ? err.message : 'Invalid item_state',
    err instanceof JsonSchemaValidationError ? { fields: err.fields } : undefined,
  );
}

/**
 * Rejects caller-supplied coordinates outside the configured country.
 *
 * Only for points the caller resolved (a bulk `geo_location` cell, an
 * autocomplete pick, a partner's `item_locations`), which skip the geocoder's
 * own country restriction. Geocoded points are not checked: geocoding is
 * best-effort and a point on a simplified border line must not fail a
 * registration. A no-op when `GEOCODING_COUNTRY` (or the boundary file) is unset.
 *
 * @throws {ItemServiceError} 400 LOCATION_OUTSIDE_COUNTRY, naming the point so a
 *   bulk operator can find the row.
 */
export async function assertSuppliedLocationsInCountry(
  points: readonly ItemLocation[] | undefined,
): Promise<void> {
  if (!points?.length) return;
  const outside = await findLocationOutsideCountry(points);
  if (!outside) return;
  throw new ItemServiceError(
    400,
    'LOCATION_OUTSIDE_COUNTRY',
    `Location ${outside.lat}, ${outside.lng} is outside the allowed region (${geocodingConfig.country}).`,
  );
}

/**
 * Whether `userId` is the creator of the item, queried on the full partition
 * key so Postgres can prune partitions.
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
   * Whether profile_creation consent is accepted as part of this create. When
   * true, a complete item can go `live` immediately; when false (admin/bulk
   * onboarding, or a gated minor), it stays `draft` until
   * POST /consent/profile-accept promotes it. Defaults to false.
   */
  consent_accepted?: boolean;
  /**
   * Skip the per-user profile cap (MAX_PROFILES_PER_USER / the domain's
   * `max_profiles_per_user`). For trusted internal callers such as seed
   * scripts only; every request-driven create path is capped.
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
    throw invalidItemStateError(err);
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
 * A transaction-scoped advisory lock on (user, network, domain, item_type)
 * serializes concurrent creates so two racing inserts can't both pass the
 * count check. Throws 409 PROFILE_LIMIT_REACHED at the cap.
 *
 * Retired rows do not hold a slot: retiring is the remedy the 409 message
 * offers. This is safe only because `retired` is terminal (no
 * retire-create-unretire path); revisit if retire becomes reversible. The
 * filter is a denylist so any future lifecycle state still consumes a slot.
 *
 * The single-domain lock (`single_domain_lock.ts`) intentionally does count
 * retired items: it protects the per-account tenancy key, which retire does not
 * reset.
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
        ne(items.lifecycle_status, 'retired'),
      ),
    );

  if ((row?.n ?? 0) >= limit) {
    throw new ItemServiceError(
      409,
      'PROFILE_LIMIT_REACHED',
      `This user already has the maximum of ${limit} ${params.item_domain} profile(s) allowed. Retire an existing profile to create a new one.`,
    );
  }
}

/**
 * Single-domain lock on the create path. Enforced here so every create path
 * (including admin api-key callers and `POST /admin/participant`) inherits it.
 * The rule and SQL live in `services/items/single_domain_lock.ts`, shared with
 * `POST /api/v1/user/domains`.
 *
 * Only a mismatch is refused: a first create, a repeat in the same domain, and a
 * backfilled legacy account in either of its domains all pass.
 *
 * @throws ItemServiceError 403 DOMAIN_LOCKED when the account is locked to
 *   another domain. The body carries `locked_domain` / `requested_domain`.
 */
async function assertSingleDomain(
  exec: DbOrTx,
  params: Pick<CreateItemServiceParams, 'created_by' | 'item_domain'>,
): Promise<void> {
  if (await claimDomain(exec, params.created_by, params.item_domain)) return;

  const allowed = await readLockedDomains(exec, params.created_by);

  // Empty ⇒ the user row is missing (`claimDomain` declines for an account that
  // owns items, so an existing account never lands here empty). Let the items
  // FK raise that, rather than dressing a missing user up as a domain error.
  if (allowed.length === 0 || allowed.includes(params.item_domain)) return;

  throw new ItemServiceError(
    403,
    'DOMAIN_LOCKED',
    domainLockedMessage(allowed[0] as string, params.item_domain, 'create items under'),
    { locked_domain: allowed[0], requested_domain: params.item_domain },
  );
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

  // The domain lock runs before the cap: a wrong domain is the more fundamental
  // refusal, and a fixed order keeps the two guards' locks acquired consistently.
  await assertSingleDomain(exec, params);

  // Enforced here so every create path (item/create, admin/participant,
  // aggregator bulk + reg-links) inherits the cap atomically.
  if (!params.skip_profile_limit) {
    await assertProfileLimit(exec, params);
  }

  const masked = maskPrivateState(itemSchema, itemState.privateState);
  const itemStateForStorage = mergeMasksIntoPublic(itemState.publicState, masked);
  const encryptedPrivate =
    Object.keys(itemState.privateState).length === 0
      ? ''
      : encryptPiiBlob(JSON.stringify(itemState.privateState), getPiiKey());

  // A create carrying consent is the profile_creation acceptance, so it can go
  // live now. Consent-less callers stay draft until POST /consent/profile-accept.
  // For a gated minor create_item passes `consent_accepted=false` (self-consent
  // must not promote a minor); guardian consent promotes later via
  // promoteItemOnProfileConsent.
  const goLiveGates = await resolveGoLiveGates(params.item_network, params.item_domain);
  const classification = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: submittedItemState,
    current_status: 'draft',
    // Read-only gate check. create_item calls `tagUserWithDefaultAggregator`
    // earlier in this same transaction.
    owner_context: await ownerGateContext(
      exec,
      goLiveGates,
      params.created_by,
      params.item_network,
      params.item_domain,
    ),
    // No separate guardian check here: create_item already passes false for a
    // gated minor.
    consent_accepted: params.consent_accepted ?? false,
    gates: goLiveGates,
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
      // Callers need it to pick the create email copy (live vs complete-your-profile).
      lifecycleStatus: items.lifecycle_status,
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

/** Whether a domain's configured gate set includes the `owner_required` gate. */
function gatesRequireOwner(gates: readonly GoLiveGate[]): boolean {
  return gates.includes('owner_required');
}

/**
 * The `owner_required` gate context for one profile write. Read-only: tagging
 * happens at the account level (`tagUserForDomain` /
 * `tagUserWithDefaultAggregator`) when the user's domain is decided.
 *
 * @returns undefined when the domain does not configure `owner_required` (the
 *   default), so this normally costs nothing.
 */
async function ownerGateContext(
  exec: DbOrTx,
  gates: readonly GoLiveGate[],
  ownerUserId: string,
  network: string,
  domain: string,
): Promise<OwnerGateContext | undefined> {
  if (!gatesRequireOwner(gates)) return undefined;
  return resolveOwnerGateContext(exec, ownerUserId, network, domain);
}

/**
 * The go-live gate set for a (network, domain), from the domain's
 * `go_live_required` config, or `DEFAULT_GO_LIVE_GATES` when unset. Callers
 * pass the result into `classify_item` and use it to decide whether the U18
 * guardian check applies (it is part of the `consent_required` gate).
 */
export async function resolveGoLiveGates(
  network: string,
  domain: string,
): Promise<readonly GoLiveGate[]> {
  const networkConfig = await getNetworkConfigById(network);
  const domainConfig = networkConfig.domains.find((d) => d.id === domain);
  const gates = domainConfig?.go_live_required ?? DEFAULT_GO_LIVE_GATES;
  // The U18 guardian check lives in `consent_required`, so a guardian-gated
  // domain always gets that gate: the age gate must never be droppable by config.
  if (domainConfig?.guardian_consent_required && !gates.includes('consent_required')) {
    return [...gates, 'consent_required'];
  }
  return gates;
}

/**
 * Server-authoritative U18 go-live gate: true when an item must not go
 * `draft → live` because a guardian-gated domain lacks guardian consent. Used by
 * /consent/profile-accept promotion and item update; the create path applies
 * the same rule in create_item's `resolveSelfConsentPromotes`. Fails closed:
 *
 *  - Null age on a gated domain blocks: age capture is client-side
 *    (u18_precheck is a hint, not a control), so a missing age is never "adult".
 *  - A minor with no `source='guardian'` profile_creation row blocks: the
 *    ward's own self-consent row cannot promote.
 *
 * A proven adult, and any user on a non-gated domain, is never blocked.
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
  return !guardianRow;
}

/**
 * Promote a `draft` profile to `live` after its owner accepts
 * `profile_creation` consent, re-running the write-path classifier so the
 * completeness rules stay in one place. `paused` is sticky and `live` needs no
 * change. Returns true if it flipped to live.
 *
 * The caller must already have recorded the consent row and verified ownership;
 * this only re-evaluates lifecycle.
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

  const goLiveGates = await resolveGoLiveGates(item.item_network, item.item_domain);
  // The caller recorded the consent row, so `consent_required` reduces to the
  // U18 guardian check (fail-closed for a gated minor or null age).
  const consentSatisfied = !(await guardianGateBlocksGoLive(exec, item));
  const { lifecycle_status } = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: mergedFullState,
    current_status: 'draft',
    consent_accepted: consentSatisfied,
    gates: goLiveGates,
    owner_context: await ownerGateContext(
      exec,
      goLiveGates,
      item.created_by,
      item.item_network,
      item.item_domain,
    ),
  });

  if (lifecycle_status !== 'live') return false;

  await exec
    .update(items)
    .set({ lifecycle_status: 'live', updated_at: sql`now()` })
    .where(eq(items.item_id, itemId));
  return true;
}

/**
 * Record a minor's guardian `profile_creation` consent for an item and promote
 * it live in one step. Shared by the U18 profile-consent verify and finalize
 * handlers. Returns whether the item was promoted to live.
 */
export async function upsertGuardianProfileConsentAndPromote(
  tx: DbOrTx,
  args: { userId: string; itemId: string; network: string; brand?: string | null; documentVersion: number },
): Promise<boolean> {
  await tx
    .insert(consent_record)
    .values(guardianProfileConsentRow(args))
    // Adds a source='guardian' row beside the ward's own source='profile' row.
    // A repeat guardian acceptance for the same item updates in place.
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

/** The existing-item fields `updateItemInternal`'s state/location helpers read. */
interface ExistingItemForUpdate {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_schema_url: string | null;
  item_state: unknown;
  item_private_state: string;
  lifecycle_status: string;
  created_by: string;
  item_locations: unknown;
}

/**
 * Computes the `item_state` / `item_private_state` / `lifecycle_status` writes
 * for a state-changing update: decrypt + merge the prior state, validate,
 * enforce the live latch, split private fields, and re-classify go-live
 * (guardian-aware consent folded in).
 *
 * @returns The merged full state + whether the primary address changed (for
 *          downstream location resolution) and the column writes to apply.
 * @throws {ItemServiceError} 400 INVALID_ITEM_STATE / 409 REQUIRED_FIELD_LOCKED_WHILE_LIVE.
 */
async function computeItemStateUpdate(
  exec: DbOrTx,
  existingItem: ExistingItemForUpdate,
  itemSchema: Awaited<ReturnType<typeof getOrFetchSchemaByUrl>>,
  bodyState: Record<string, unknown>,
): Promise<{
  mergedFullState: Record<string, unknown>;
  addressChanged: boolean;
  writes: { item_state: unknown; item_private_state: string; lifecycle_status: string };
}> {
  const priorPrivate =
    existingItem.item_private_state === ''
      ? {}
      : (JSON.parse(decryptPiiBlob(existingItem.item_private_state, getPiiKey())) as Record<
          string,
          unknown
        >);
  const priorFullState = mergeItemStateWithPrivate(
    existingItem.item_state as Record<string, unknown>,
    priorPrivate,
  );
  const mergedFullState = { ...priorFullState, ...bodyState };
  const addressChanged = primaryAddressChanged(
    itemSchema as Record<string, unknown>,
    bodyState,
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
    throw invalidItemStateError(err);
  }

  // Live latch: a live profile must stay complete, so an edit that empties a
  // required field is rejected (docs/superpowers/specs/2026-06-10-live-latch-design.md).
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
  const item_state = mergeMasksIntoPublic(split.publicState, masked);
  const item_private_state =
    Object.keys(split.privateState).length === 0
      ? ''
      : encryptPiiBlob(JSON.stringify(split.privateState), getPiiKey());

  // `consent_required` folds in the U18 guardian check so a minor's self-consent
  // row can't flip the item live (the classifier just evaluates configured gates).
  const goLiveGates = await resolveGoLiveGates(existingItem.item_network, existingItem.item_domain);
  const consentSatisfied =
    (await hasAcceptedProfileConsent(exec, existingItem.item_id)) &&
    !(await guardianGateBlocksGoLive(exec, existingItem));
  const classification = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: mergedFullState,
    current_status: existingItem.lifecycle_status as 'draft' | 'live' | 'paused',
    consent_accepted: consentSatisfied,
    gates: goLiveGates,
    // Only needed for a draft: `owner_required` passes for an already-live item
    // and `paused` is sticky, so the lookup is skipped for most edits.
    owner_context:
      existingItem.lifecycle_status === 'draft'
        ? await ownerGateContext(
            exec,
            goLiveGates,
            existingItem.created_by,
            existingItem.item_network,
            existingItem.item_domain,
          )
        : undefined,
  });

  return {
    mergedFullState,
    addressChanged,
    writes: { item_state, item_private_state, lifecycle_status: classification.lifecycle_status },
  };
}

/**
 * Resolves the `item_locations` write for an update, in precedence order:
 * explicit non-empty client coords win (re-jitter unless echoed back); else an
 * edited primary address re-geocodes (blank → wipe, geocode hit → store,
 * geocode miss → keep existing); else leave unchanged.
 *
 * @returns The locations to write, or `undefined` to leave them unchanged.
 */
async function resolveLocationUpdate(
  existingItem: ExistingItemForUpdate,
  itemSchema: Awaited<ReturnType<typeof getOrFetchSchemaByUrl>>,
  bodyLocations: ItemLocation[] | undefined,
  mergedFullState: Record<string, unknown>,
  addressChanged: boolean,
): Promise<ItemLocation[] | undefined> {
  const providedCoords =
    Array.isArray(bodyLocations) && bodyLocations.length > 0 ? bodyLocations : null;
  if (providedCoords) {
    const stored = (existingItem.item_locations ?? []) as ItemLocation[];
    // Echoed-back stored coordinates are not re-checked, so an unrelated edit
    // never fails on a point stored before the country restriction applied.
    if (sameLocations(providedCoords, stored)) return stored;
    await assertSuppliedLocationsInCountry(providedCoords);
    return locationsForStorage(providedCoords, itemSchema as Record<string, unknown>);
  }
  if (addressChanged) {
    if (isPrimaryAddressBlank(itemSchema as Record<string, unknown>, mergedFullState)) {
      return [];
    }
    const geocoded = await geocodeLocationsFromState(
      itemSchema as Record<string, unknown>,
      mergedFullState,
    );
    if (geocoded.length > 0) {
      return locationsForStorage(geocoded, itemSchema as Record<string, unknown>);
    }
  }
  return undefined;
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

  // The schema is needed to merge/validate state, classify lifecycle, and
  // jitter a private location field.
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

    // Retire wiped this row's PII and is terminal. The owner still owns the row,
    // so without this a PATCH would re-introduce the PII retire erased.
    if (existingItem.lifecycle_status === 'retired') {
      throw new ItemServiceError(
        409,
        'ITEM_RETIRED',
        'This profile is retired and can no longer be edited',
      );
    }

    const itemSchema = await getOrFetchSchemaByUrl({
      schemaUrl: existingItem.item_schema_url,
      network: existingItem.item_network,
      domain: existingItem.item_domain,
      itemType: existingItem.item_type,
    });

    // Populated only when item_state is part of this update.
    let mergedFullState: Record<string, unknown> = {};
    let addressChanged = false;

    if (body.item_state) {
      const stateUpdate = await computeItemStateUpdate(
        exec,
        existingItem,
        itemSchema,
        body.item_state,
      );
      mergedFullState = stateUpdate.mergedFullState;
      addressChanged = stateUpdate.addressChanged;
      Object.assign(updateValues, stateUpdate.writes);
    }

    // Runs after the state merge; `undefined` leaves item_locations unchanged.
    const locationUpdate = await resolveLocationUpdate(
      existingItem,
      itemSchema,
      body.item_locations,
      mergedFullState,
      addressChanged,
    );
    if (locationUpdate !== undefined) {
      updateValues.item_locations = locationUpdate;
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
