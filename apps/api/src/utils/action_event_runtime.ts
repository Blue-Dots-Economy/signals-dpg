import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import z, {
  PerformActionBodySchema,
  PerformNetworkActionBodySchema,
  StoreEventBodySchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { action_events, items } from '@dpg/database';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';

type ActionItemRef = z.infer<typeof PerformNetworkActionBodySchema>['source_item'];
type PerformActionTargetItemRef = z.infer<
  typeof PerformActionBodySchema
>['target_item'];
export type StoredActionEvent = z.infer<typeof StoreEventBodySchema>;

export type ActionEventPayloadContext = {
  action_type: string;
  source_item: ActionItemRef;
  target_item: ActionItemRef;
  requirements_snapshot: Record<string, unknown>;
};

const actionEventSystemPayloadKeys = ['status', 'remark'] as const;

export function normalizeInstanceUrl(url: string) {
  const parsedUrl = new URL(url);

  if (
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '::1'
  ) {
    parsedUrl.hostname = 'localhost';
  }

  if (
    (parsedUrl.protocol === 'http:' && parsedUrl.port === '80') ||
    (parsedUrl.protocol === 'https:' && parsedUrl.port === '443')
  ) {
    parsedUrl.port = '';
  }

  return parsedUrl.toString().replace(/\/$/, '');
}

export async function fetchLocalItemSnapshot(
  db: NodePgDatabase<any>,
  item: ActionItemRef
) {
  const baseConditions = and(
    eq(items.item_network, item.item_network),
    eq(items.item_domain, item.item_domain),
    eq(items.item_type, item.item_type),
    eq(items.item_id, item.item_id)
  );

  const [exactResult] = await db
    .select({
      item_id: items.item_id,
      item_instance_url: items.item_instance_url,
      item_private_state: items.item_private_state,
      created_by: items.created_by,
      item_latitude: items.item_latitude,
      item_longitude: items.item_longitude,
    })
    .from(items)
    .where(and(baseConditions, eq(items.item_instance_url, item.item_instance_url)))
    .limit(1);

  if (exactResult) {
    return exactResult;
  }

  const normalizedItemInstanceUrl = normalizeInstanceUrl(item.item_instance_url);
  const normalizedCurrentInstanceUrl = normalizeInstanceUrl(getCurrentApiBaseUrl());
  if (normalizedItemInstanceUrl !== normalizedCurrentInstanceUrl) {
    return null;
  }

  const [localAliasResult] = await db
    .select({
      item_id: items.item_id,
      item_instance_url: items.item_instance_url,
      item_private_state: items.item_private_state,
      created_by: items.created_by,
      item_latitude: items.item_latitude,
      item_longitude: items.item_longitude,
    })
    .from(items)
    .where(baseConditions)
    .limit(1);

  if (
    localAliasResult &&
    normalizeInstanceUrl(localAliasResult.item_instance_url) ===
      normalizedCurrentInstanceUrl
  ) {
    return localAliasResult;
  }

  return null;
}

export async function insertActionEvent(
  db: NodePgDatabase<any>,
  event: StoredActionEvent
) {
  const [created] = await db
    .insert(action_events)
    .values({
      action_type: event.action_type,
      partition_network: getActionEventPartitionNetwork(event),
      origin_instance_domain: event.origin_instance_domain,
      action_id: event.action_id,
      action_status: event.action_status,
      update_count: event.update_count,
      source_item_network: event.source_item.item_network,
      source_item_domain: event.source_item.item_domain,
      source_item_type: event.source_item.item_type,
      source_item_id: event.source_item.item_id,
      source_item_instance_url: event.source_item.item_instance_url,
      source_item_owner: event.source_item_owner,
      source_item_latitude: event.source_item_latitude ?? null,
      source_item_longitude: event.source_item_longitude ?? null,
      target_item_network: event.target_item.item_network,
      target_item_domain: event.target_item.item_domain,
      target_item_type: event.target_item.item_type,
      target_item_id: event.target_item.item_id,
      target_item_instance_url: event.target_item.item_instance_url,
      target_item_owner: event.target_item_owner,
      target_item_latitude: event.target_item_latitude ?? null,
      target_item_longitude: event.target_item_longitude ?? null,
      event_payload: event.event_payload,
      remarks: event.remarks ?? null,
    })
    .onConflictDoNothing({
      target: [
        action_events.partition_network,
        action_events.action_type,
        action_events.origin_instance_domain,
        action_events.action_id,
        action_events.update_count,
      ],
    })
    .returning({
      event_id: action_events.event_id,
      action_id: action_events.action_id,
      action_type: action_events.action_type,
      action_status: action_events.action_status,
      update_count: action_events.update_count,
    });

  return created ?? null;
}

function getActionEventPartitionNetwork(event: StoredActionEvent) {
  if (isCurrentInstanceItem(event.target_item)) {
    return event.target_item.item_network;
  }

  return event.source_item.item_network;
}

export function isCurrentInstanceItem(item: ActionItemRef) {
  return (
    normalizeInstanceUrl(item.item_instance_url) ===
    normalizeInstanceUrl(getCurrentApiBaseUrl())
  );
}

export function buildNetworkActionTargetItem(
  item: PerformActionTargetItemRef
): ActionItemRef {
  return {
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
    item_instance_url: item.item_instance_url,
  };
}

export function buildActionEventPayload(input: {
  event_schema?: Record<string, unknown>;
  action_status: string;
  remarks?: string | null;
  context: ActionEventPayloadContext;
}): Record<string, unknown> {
  return {
    ...projectEventPayloadFromSchema(input.event_schema, input.context),
    status: input.action_status,
    remark: input.remarks ?? defaultActionEventRemark(input.action_status),
  };
}

export function validateActionEventPayload(
  eventSchema: Record<string, unknown> | undefined,
  eventPayload: Record<string, unknown>
) {
  if (!eventSchema || Object.keys(eventSchema).length === 0) {
    return;
  }

  validateAgainstJsonSchema(eventSchema, eventPayload, 'event payload', {
    allowAdditionalProperties: apiConfig.allow_extra_schema_data,
    ignoredKeys: actionEventSystemPayloadKeys,
  });
}

function projectEventPayloadFromSchema(
  eventSchema: Record<string, unknown> | undefined,
  context: ActionEventPayloadContext
) {
  if (!eventSchema || Object.keys(eventSchema).length === 0) {
    return {};
  }

  const properties = isPlainObject(eventSchema.properties)
    ? eventSchema.properties
    : {};
  const payload: Record<string, unknown> = {};
  const contextRecord = context as unknown as Record<string, unknown>;

  for (const key of Object.keys(properties)) {
    if (isActionEventSystemPayloadKey(key)) {
      continue;
    }

    if (Object.hasOwn(contextRecord, key)) {
      payload[key] = contextRecord[key];
      continue;
    }

    if (Object.hasOwn(context.requirements_snapshot, key)) {
      payload[key] = context.requirements_snapshot[key];
    }
  }

  return payload;
}

function isActionEventSystemPayloadKey(
  key: string
): key is typeof actionEventSystemPayloadKeys[number] {
  return actionEventSystemPayloadKeys.includes(
    key as typeof actionEventSystemPayloadKeys[number]
  );
}

function defaultActionEventRemark(actionStatus: string) {
  return `Action status set to ${actionStatus}`;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export async function mirrorActionEventToSourceInstance(
  event: StoredActionEvent,
  log: FastifyBaseLogger
) {
  if (
    normalizeInstanceUrl(event.source_item.item_instance_url) ===
    normalizeInstanceUrl(getCurrentApiBaseUrl())
  ) {
    return;
  }

  try {
    const response = await fetch(
      new URL('/api/v1/event/store', event.source_item.item_instance_url),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (!response.ok) {
      log.error(
        {
          action_id: event.action_id,
          source_instance_url: event.source_item.item_instance_url,
          status_code: response.status,
          status_text: response.statusText,
        },
        'Failed to mirror action event to source instance'
      );
    }
  } catch (err) {
    log.error(
      {
        err,
        action_id: event.action_id,
        source_instance_url: event.source_item.item_instance_url,
      },
      'Failed to mirror action event to source instance'
    );
  }
}
