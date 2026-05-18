import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const item_actions = pgTable(
  'item_actions',
  {
    action_type: text('action_type').notNull(),
    partition_network: text('partition_network').notNull(),
    action_id: uuid('action_id').defaultRandom().notNull(),
    action_status: text('action_status').notNull(),
    update_count: integer('update_count').notNull().default(0),

    source_item_network: text('source_item_network').notNull(),
    source_item_domain: text('source_item_domain').notNull(),
    source_item_type: text('source_item_type').notNull(),
    source_item_id: uuid('source_item_id').notNull(),
    source_item_instance_url: text('source_item_instance_url').notNull(),
    source_item_owner: text('source_item_owner'),

    target_item_network: text('target_item_network').notNull(),
    target_item_domain: text('target_item_domain').notNull(),
    target_item_type: text('target_item_type').notNull(),
    target_item_id: uuid('target_item_id').notNull(),
    target_item_instance_url: text('target_item_instance_url').notNull(),
    target_item_owner: text('target_item_owner'),

    requirements_snapshot: jsonb('requirements_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    remarks: text('remarks'),

    created_at: timestamp('created_at')
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updated_at: timestamp('updated_at')
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.partition_network, table.action_type, table.action_id],
    }),
    index('item_actions_source_owner_idx').on(
      table.source_item_owner,
      table.updated_at
    ),
    index('item_actions_target_owner_idx').on(
      table.target_item_owner,
      table.updated_at
    ),
  ]
);
