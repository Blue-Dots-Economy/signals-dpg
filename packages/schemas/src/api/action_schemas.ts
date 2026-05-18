import { action_events, item_actions } from '@dpg/database';
import { createSelectSchema } from 'drizzle-zod';
import z from 'zod';

const ActionItemRefSchema = z.object({
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  item_id: z.uuid(),
});

export const ActionTargetItemRefSchema = ActionItemRefSchema.extend({
  item_instance_url: z.url(),
});

export const ActionItemRefWithInstanceSchema = ActionItemRefSchema.extend({
  item_instance_url: z.url(),
});

export const PerformActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefSchema,
  target_item: ActionTargetItemRefSchema,
  requirements_snapshot: z.record(z.string(), z.unknown()),
});

export const PerformNetworkActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefWithInstanceSchema,
  target_item: ActionItemRefWithInstanceSchema,
  source_item_owner: z.string().min(1),
  requirements_snapshot: z.record(z.string(), z.unknown()),
});

export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
});

export const StoreEventBodySchema = z.object({
  origin_instance_domain: z.url(),
  action_type: z.string().min(1),
  action_id: z.uuid(),
  action_status: z.string().min(1),
  update_count: z.int().nonnegative(),
  source_item: ActionItemRefWithInstanceSchema,
  target_item: ActionItemRefWithInstanceSchema,
  source_item_owner: z.string().min(1).nullable().optional(),
  target_item_owner: z.string().min(1).nullable().optional(),
  source_item_latitude: z.number().nullable().optional(),
  source_item_longitude: z.number().nullable().optional(),
  target_item_latitude: z.number().nullable().optional(),
  target_item_longitude: z.number().nullable().optional(),
  event_payload: z.record(z.string(), z.unknown()).default({}),
  remarks: z.string().min(1).optional(),
});

export const ActionOwnershipRoleSchema = z.enum(['all', 'initiated', 'received']);
export const ActionOwnershipTagSchema = z.enum(['initiated', 'received']);

const FetchOwnedRecordsQuerySchemaBase = z.object({
  action_id: z.uuid().optional(),
  action_type: z.string().min(1).optional(),
  action_status: z.string().min(1).optional(),
  item_id: z.uuid().optional(),
  ownership_role: ActionOwnershipRoleSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const FetchOwnedActionsQuerySchema = FetchOwnedRecordsQuerySchemaBase;

export const FetchOwnedEventsQuerySchema = FetchOwnedRecordsQuerySchemaBase.extend({
  update_count: z.coerce.number().int().nonnegative().optional(),
});

export const ItemActionSelectSchema = createSelectSchema(item_actions);
export const ActionEventSelectSchema = createSelectSchema(action_events);

export const OwnedItemActionSchema = ItemActionSelectSchema.extend({
  ownership_roles: ActionOwnershipTagSchema.array().min(1),
});

export const OwnedActionEventSchema = ActionEventSelectSchema.extend({
  ownership_roles: ActionOwnershipTagSchema.array().min(1),
});
