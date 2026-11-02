import { action_events, item_actions } from '@dpg/database';
import { createSelectSchema } from 'drizzle-zod';
import z from 'zod';
import { ItemLocationsArray, ItemResponseSchema } from './item_schemas';

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

export const ConsentAckSchema = z
  .object({
    acknowledged: z.literal(true),
    version: z.number().int().min(1),
    brand: z.string().min(1).nullish(),
  })
  .strict();

export type ConsentAck = z.infer<typeof ConsentAckSchema>;

export const PerformActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefSchema,
  target_item: ActionTargetItemRefSchema,
  // Defaults to `{}` because some external callers cannot serialise an empty
  // object. The interaction's `requirement_schema` is still enforced
  // downstream, so an action that requires fields fails there.
  requirements_snapshot: z.record(z.string(), z.unknown()).default({}),
  acting_as_user_id: z.string().min(1).optional(),
  consent: ConsentAckSchema.optional(),
  guardian_otp: z.string().length(6).optional(),
});

export const PerformNetworkActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefWithInstanceSchema,
  target_item: ActionItemRefWithInstanceSchema,
  source_item_owner: z.string().min(1),
  // Defaults to `{}` for a peer that omits it on a no-requirements action;
  // per-action requirements are still enforced.
  requirements_snapshot: z.record(z.string(), z.unknown()).default({}),
  performed_by_org_id: z.string().min(1).nullable().optional(),
  performed_by_service_user_id: z.string().min(1).nullable().optional(),
  consent: ConsentAckSchema.optional(),
  guardian_otp: z.string().length(6).optional(),
});

export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
  consent: ConsentAckSchema.optional(),
  guardian_otp: z.string().length(6).optional(),
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
  source_item_locations: ItemLocationsArray.optional(),
  target_item_locations: ItemLocationsArray.optional(),
  event_payload: z.record(z.string(), z.unknown()).default({}),
  remarks: z.string().min(1).optional(),
});

export const ActionOwnershipRoleSchema = z.enum(['all', 'initiated', 'received']);
export const ActionOwnershipTagSchema = z.enum(['initiated', 'received']);

// A repeatable query param arrives as a string when sent once; normalise to an
// array, leaving `undefined` (absent) untouched.
const toStringArray = (v: string | string[] | undefined) => {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
};

export const ActionSortKeySchema = z.enum(['recent', 'oldest', 'match_score', 'distance']);

/** Longest `q` accepted by the owned-action list and export. */
export const ACTION_SEARCH_MAX = 100;
/** Most profiles one owned-action query can scope to. */
export const ACTION_ITEM_IDS_MAX = 50;

/**
 * One schema-driven filter on the counterparty's item_state. `domain` (optional)
 * limits the selection to counterparties in that domain, so two domains that
 * share a field name are filtered independently.
 */
export const ActionFacetSelectionSchema = z.object({
  domain: z.string().min(1).optional(),
  field: z.string().min(1),
  values: z.array(z.string()).min(1),
});

/** Extra, opt-in parts of the owned-action list response. */
export const ActionFetchIncludeSchema = z.enum(['counts', 'column_fields']);

/** A single value or an array → an array; absent stays absent. */
function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

const ItemIdsParam = z
  .union([z.uuid(), z.array(z.uuid()).max(ACTION_ITEM_IDS_MAX)])
  .optional()
  .transform(asArray);

const FetchOwnedRecordsQuerySchemaBase = z.object({
  action_id: z.uuid().optional(),
  action_type: z.string().min(1).optional(),
  action_status: z.string().min(1).optional(),
  item_id: z.uuid().optional(),
  ownership_role: ActionOwnershipRoleSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const FetchOwnedActionsQuerySchema = FetchOwnedRecordsQuerySchemaBase.extend({
  action_type: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional()
    .transform(toStringArray),
  action_status: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional()
    .transform(toStringArray),
  // Several of the caller's profiles at once; `item_id` stays as the
  // single-profile alias. Omitting both = every profile the caller owns.
  item_ids: ItemIdsParam,
  // Free-text search on the counterparty's UNMASKED name (public, or revealed
  // on this row) and the caller's own item name. A masked name never matches.
  q: z.string().trim().min(1).max(ACTION_SEARCH_MAX).optional(),
  sort: ActionSortKeySchema.default('recent'),
  facets: z.array(ActionFacetSelectionSchema).optional(),
  include: z
    .union([ActionFetchIncludeSchema, z.array(ActionFetchIncludeSchema)])
    .optional()
    .transform((v) => asArray(v) ?? []),
});

/**
 * Request-shape bounds for `POST /api/v1/action/export`.
 * `EXPORT_ACTION_IDS_MAX` is the hard ceiling of one export; the configured
 * `EXPORT_MAX_ROWS` (checked by the route, 413) may be set up to it.
 */
export const EXPORT_ACTION_IDS_MAX = 50_000;
export const EXPORT_FACETS_MAX = 20;
export const EXPORT_FACET_VALUES_MAX = 100;

/**
 * `POST /api/v1/action/export` body. The filters mirror the owned-action list
 * filters (minus paging/sort) so "what I see" and "what I export" are the same
 * rows.
 */
export const ExportActionsBodySchema = z
  .object({
    filters: z
      .object({
        action_type: z.array(z.string().min(1)).optional(),
        // Omitted = every exportable status. An empty list is refused rather
        // than read as "all", so a view filtered to non-exportable statuses
        // cannot widen into an export of every revealed engagement.
        action_status: z.array(z.string().min(1)).min(1).optional(),
        ownership_role: ActionOwnershipRoleSchema.default('all'),
        item_id: z.uuid().optional(),
        item_ids: z.array(z.uuid()).min(1).max(ACTION_ITEM_IDS_MAX).optional(),
        q: z.string().trim().min(1).max(ACTION_SEARCH_MAX).optional(),
        // One file = one counterparty (network, domain, item_type); these select it when
        // the caller's rows span more than one.
        counterparty_network: z.string().min(1).optional(),
        counterparty_domain: z.string().min(1).optional(),
        counterparty_item_type: z.string().min(1).optional(),
        // Hard upper bounds so a body can never become an unbounded IN-list or
        // audit payload; the route additionally enforces EXPORT_MAX_ROWS.
        action_ids: z.array(z.uuid()).min(1).max(EXPORT_ACTION_IDS_MAX).optional(),
        facets: z
          .array(
            z.object({
              domain: z.string().min(1).optional(),
              field: z.string().min(1),
              values: z.array(z.string()).min(1).max(EXPORT_FACET_VALUES_MAX),
            })
          )
          .max(EXPORT_FACETS_MAX)
          .optional(),
        updated_from: z.coerce.date().optional(),
        updated_to: z.coerce.date().optional(),
      })
      .strict()
      .default({ ownership_role: 'all' }),
    projection: z
      .object({
        fields: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]),
      })
      .strict()
      .default({ fields: '*' }),
    include: z.array(z.enum(['match_score'])).default([]),
    format: z.enum(['xlsx']).default('xlsx'),
  })
  .strict();

export type ExportActionsBody = z.infer<typeof ExportActionsBodySchema>;

export const FetchOwnedEventsQuerySchema = FetchOwnedRecordsQuerySchemaBase.extend({
  update_count: z.coerce.number().int().nonnegative().optional(),
});

export const ItemActionSelectSchema = createSelectSchema(item_actions);
export const ActionEventSelectSchema = createSelectSchema(action_events);

export const OwnedItemActionSchema = ItemActionSelectSchema.extend({
  ownership_roles: ActionOwnershipTagSchema.array().min(1),
  // Names from each item's display_name_field: masked when the field is
  // private and not revealed on this row, null when no name resolves.
  source_item_name: z.string().nullable().optional(),
  target_item_name: z.string().nullable().optional(),
  // `distance_m` is not a column: it is computed at read time from the two
  // items' locations.
  match_score: z.number().nullable().optional(),
  distance_m: z.number().nullable().optional(),
  // `include=column_fields` only: the counterparty's item kind and its
  // interaction `column_fields`, non-private fields only.
  counterparty: z
    .object({
      network: z.string(),
      domain: z.string(),
      item_type: z.string(),
      column_fields: z.record(z.string(), z.unknown()),
    })
    .nullable()
    .optional(),
});

/** `include=counts`: totals for the saved views over the same base filter. */
export const OwnedActionCountsSchema = z.object({
  all: z.number(),
  needs_response: z.number(),
  ready_to_export: z.number(),
  sent: z.number(),
});

export const OwnedActionEventSchema = ActionEventSelectSchema.extend({
  ownership_roles: ActionOwnershipTagSchema.array().min(1),
});

export const ActionContactDetailsParamsSchema = z.object({
  action_id: z.uuid(),
});

export const ActionContactDetailsResponseSchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  // true: `item` carries the revealed contact PII; false: the masked view.
  revealed: z.boolean(),
  // When not revealed, whose profile blocked it: `self` = the viewer's own
  // profile is not live; `other` = the counterparty's is not; `retired` = the
  // counterparty retired theirs.
  reveal_blocked_reason: z.enum(['self', 'other', 'retired']).optional(),
  other_actor: z.object({
    item: ItemResponseSchema,
  }),
});
