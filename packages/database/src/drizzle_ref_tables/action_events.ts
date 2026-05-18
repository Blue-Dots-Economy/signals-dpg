import {
  doublePrecision,
  integer,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Drizzle reference table for the partitioned `action_events` parent table.
export const action_events = pgTable(
  'action_events',
  {
    action_type: text('action_type').notNull(),
    partition_network: text('partition_network').notNull(),
    event_id: uuid('event_id').defaultRandom().notNull(),
    origin_instance_domain: text('origin_instance_domain').notNull(),
    action_id: uuid('action_id').notNull(),
    action_status: text('action_status').notNull(),
    update_count: integer('update_count').notNull(),

    source_item_network: text('source_item_network').notNull(),
    source_item_domain: text('source_item_domain').notNull(),
    source_item_type: text('source_item_type').notNull(),
    source_item_id: uuid('source_item_id').notNull(),
    source_item_instance_url: text('source_item_instance_url').notNull(),
    source_item_owner: text('source_item_owner'),
    source_item_latitude: doublePrecision('source_item_latitude'),
    source_item_longitude: doublePrecision('source_item_longitude'),

    target_item_network: text('target_item_network').notNull(),
    target_item_domain: text('target_item_domain').notNull(),
    target_item_type: text('target_item_type').notNull(),
    target_item_id: uuid('target_item_id').notNull(),
    target_item_instance_url: text('target_item_instance_url').notNull(),
    target_item_owner: text('target_item_owner'),
    target_item_latitude: doublePrecision('target_item_latitude'),
    target_item_longitude: doublePrecision('target_item_longitude'),

    event_payload: jsonb('event_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    remarks: text('remarks'),

    created_at: timestamp('created_at')
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.partition_network, table.action_type, table.event_id],
    }),
    uniqueIndex('action_events_origin_action_update_idx').on(
      table.partition_network,
      table.action_type,
      table.origin_instance_domain,
      table.action_id,
      table.update_count
    ),
    index('action_events_action_idx').on(
      table.action_type,
      table.action_id,
      table.update_count
    ),
    index('action_events_source_item_idx').on(
      table.source_item_network,
      table.source_item_domain,
      table.source_item_type,
      table.source_item_id,
      table.created_at
    ),
    index('action_events_source_owner_idx').on(
      table.source_item_owner,
      table.created_at
    ),
    index('action_events_target_item_idx').on(
      table.target_item_network,
      table.target_item_domain,
      table.target_item_type,
      table.target_item_id,
      table.created_at
    ),
    index('action_events_target_owner_idx').on(
      table.target_item_owner,
      table.created_at
    ),
  ]
);
