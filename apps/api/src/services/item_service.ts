import { and, eq, sql } from 'drizzle-orm';
import {
  getDomainItemSchema,
  getDomainItemTypes,
  getInstanceCustomItemSchemaUrl,
  maskPrivateState,
  mergeMasksIntoPublic,
  mergeItemStateWithPrivate,
  splitItemStateByPrivacy,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { classify_item } from './items/classifier.js';
import { decryptPiiBlob, encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { items } from '@dpg/database';
import { db } from '@api/db/postgres/drizzle_config';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { getNetworkConfigById } from '@/network_configs';
import {
  buildNetworkItemSchemaUrl,
  getOrFetchSchemaByUrl,
} from '@/network_schema_cache';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';

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
  item_latitude?: number | null;
  item_longitude?: number | null;
  created_by: string;
}

export interface UpdateItemServiceBody {
  item_state?: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
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
      item_latitude: params.item_latitude ?? null,
      item_longitude: params.item_longitude ?? null,
      created_by: params.created_by,
      lifecycle_status: classification.lifecycle_status,
      completion_pct: classification.completion_pct,
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
    item_latitude: number | null;
    item_longitude: number | null;
    created_by: string;
    created_at: Date;
    updated_at: Date;
  };
  leavingLive: boolean;
  itemIdForCancellation: string | null;
  networkForCancellation: string | null;
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
  if (body.item_latitude !== undefined) updateValues.item_latitude = body.item_latitude;
  if (body.item_longitude !== undefined) updateValues.item_longitude = body.item_longitude;

  let itemStateWasUpdated = false;
  let isLeavingLive = false;
  let savedItemId: string | null = null;
  let savedNetwork: string | null = null;

  if (body.item_state) {
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

    // Decrypt existing private blob (empty string => no prior private fields).
    const priorPrivate =
      existingItem.item_private_state === ''
        ? {}
        : (JSON.parse(
            decryptPiiBlob(existingItem.item_private_state, getPiiKey())
          ) as Record<string, unknown>);

    // Reconstitute the full prior state (real values, not masks).
    const priorFullState = mergeItemStateWithPrivate(
      existingItem.item_state as Record<string, unknown>,
      priorPrivate
    );

    // Layer the caller's partial update on top.
    const mergedFullState: Record<string, unknown> = { ...priorFullState, ...body.item_state };

    try {
      const required = Array.isArray((itemSchema as { required?: unknown }).required)
        ? ((itemSchema as { required?: string[] }).required as string[])
        : [];
      validateAgainstJsonSchema(itemSchema, mergedFullState, 'item_state', {
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
    updateValues.completion_pct = classification.completion_pct;

    isLeavingLive =
      existingItem.lifecycle_status === 'live' && classification.lifecycle_status !== 'live';
    itemStateWasUpdated = true;
    savedItemId = existingItem.item_id;
    savedNetwork = existingItem.item_network;
  }

  const result = await exec
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
      item_latitude: items.item_latitude,
      item_longitude: items.item_longitude,
      created_by: items.created_by,
      created_at: items.created_at,
      updated_at: items.updated_at,
    });

  if (result.length === 0) {
    throw new ItemServiceError(
      404,
      'ITEM_NOT_FOUND_OR_FORBIDDEN',
      'Item not found or does not belong to the authenticated user'
    );
  }

  return {
    row: result[0],
    leavingLive: itemStateWasUpdated && isLeavingLive,
    itemIdForCancellation: itemStateWasUpdated ? savedItemId : null,
    networkForCancellation: itemStateWasUpdated ? savedNetwork : null,
  };
}
