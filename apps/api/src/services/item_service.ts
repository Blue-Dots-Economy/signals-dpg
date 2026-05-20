import { and, eq, sql } from 'drizzle-orm';
import {
  getDomainItemSchema,
  getDomainItemTypes,
  getInstanceCustomItemSchemaUrl,
  splitItemStateByPrivacy,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
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
  aggregator_id?: string | null;
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
    validateAgainstJsonSchema(itemSchema, params.submittedItemState, 'item_state', {
      allowAdditionalProperties: apiConfig.allow_extra_schema_data,
    });
  } catch (err) {
    throw new ItemServiceError(
      400,
      'INVALID_ITEM_STATE',
      err instanceof Error ? err.message : 'Invalid item_state'
    );
  }

  const itemState = splitItemStateByPrivacy(itemSchema, params.submittedItemState);
  return { itemSchemaUrl, itemState, itemInstanceUrl };
}

export async function createItemInternal(
  exec: DbOrTx,
  params: CreateItemServiceParams
) {
  const submittedItemState = params.item_state ?? {};
  const { itemSchemaUrl, itemState, itemInstanceUrl } = await resolveSchema({
    item_network: params.item_network,
    item_domain: params.item_domain,
    item_type: params.item_type,
    submittedItemState,
  });

  const result = await exec
    .insert(items)
    .values({
      item_network: params.item_network,
      item_type: params.item_type,
      item_domain: params.item_domain,
      item_instance_url: itemInstanceUrl,
      item_schema_url: itemSchemaUrl,
      item_state: itemState.publicState,
      item_private_state: itemState.privateState,
      item_latitude: params.item_latitude ?? null,
      item_longitude: params.item_longitude ?? null,
      created_by: params.created_by,
      aggregator_id: params.aggregator_id ?? null,
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

export async function updateItemInternal(
  exec: DbOrTx,
  itemId: string,
  callerId: string,
  isAdmin: boolean,
  body: UpdateItemServiceBody
) {
  const ownershipFilter = isAdmin
    ? eq(items.item_id, itemId)
    : and(eq(items.item_id, itemId), eq(items.created_by, callerId));

  const updateValues: Record<string, unknown> = {
    ...body,
    updated_at: sql`now()`,
  };
  // aggregator_id is provenance metadata, immutable after create
  delete (updateValues as { aggregator_id?: unknown }).aggregator_id;

  if (body.item_state) {
    const [existingItem] = await exec
      .select({
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_schema_url: items.item_schema_url,
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

    try {
      validateAgainstJsonSchema(itemSchema, body.item_state, 'item_state', {
        allowAdditionalProperties: apiConfig.allow_extra_schema_data,
      });
    } catch (err) {
      throw new ItemServiceError(
        400,
        'INVALID_ITEM_STATE',
        err instanceof Error ? err.message : 'Invalid item_state'
      );
    }

    const splitState = splitItemStateByPrivacy(itemSchema, body.item_state);
    updateValues.item_state = splitState.publicState;
    updateValues.item_private_state = splitState.privateState;
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
  return result[0];
}
