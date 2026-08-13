import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
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

    performed_by_org_id: text('performed_by_org_id'),
    performed_by_service_user_id: text('performed_by_service_user_id'),

    requirements_snapshot: jsonb('requirements_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    remarks: text('remarks'),
    match_score: real('match_score'),

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
    // Per-pair action cap (#370/#422): the open-action recount matches the
    // unordered {source, target} pair from either direction. Both orderings are
    // indexed so `(source=A AND target=B) OR (source=B AND target=A)` is
    // index-served either way. Created by drizzle/0010_action_pair_open_indexes.sql.
    index('item_actions_pair_src_tgt_idx').on(
      table.partition_network,
      table.source_item_id,
      table.target_item_id
    ),
    index('item_actions_pair_tgt_src_idx').on(
      table.partition_network,
      table.target_item_id,
      table.source_item_id
    ),
    // #439: My-Actions per-profile filter/sort needs to page an owner's
    // actions by status and recency from either side of the relation.
    // Created by drizzle/0011_action_owner_status_indexes.sql.
    index('item_actions_target_owner_status_idx').on(
      table.target_item_owner,
      table.action_status,
      table.updated_at
    ),
    index('item_actions_source_owner_status_idx').on(
      table.source_item_owner,
      table.action_status,
      table.updated_at
    ),
  ]
);
