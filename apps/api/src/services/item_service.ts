import { and, eq, sql } from 'drizzle-orm';
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
import { is_populated } from './metrics/profile_completion.js';
import { decryptPiiBlob, encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { items } from '@dpg/database';
import { db } from '@api/db/postgres/drizzle_config';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { getNetworkConfigById } from '@/network_configs';
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
    jitterCoordinate(loc, geocodingConfig.jitter_min_meters, geocodingConfig.jitter_max_meters),
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

export interface CreateItemServiceParams {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state?: Record<string, unknown>;
  item_locations?: ItemLocation[];
  created_by: string;
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

  const masked = maskPrivateState(itemSchema, itemState.privateState);
  const itemStateForStorage = mergeMasksIntoPublic(itemState.publicState, masked);
  const encryptedPrivate =
    Object.keys(itemState.privateState).length === 0
      ? ''
      : encryptPiiBlob(JSON.stringify(itemState.privateState), getPiiKey());

  const classification = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: submittedItemState,
    current_status: 'draft',
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

      const classification = classify_item({
        schema: itemSchema as { required?: string[] },
        merged_state: mergedFullState,
        current_status: existingItem.lifecycle_status as 'draft' | 'live' | 'paused',
      });
      updateValues.lifecycle_status = classification.lifecycle_status;
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
      updateValues.item_locations = locationsForStorage(
        providedCoords,
        itemSchema as Record<string, unknown>
      );
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
