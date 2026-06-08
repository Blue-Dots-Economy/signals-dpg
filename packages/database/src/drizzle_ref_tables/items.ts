import {
  doublePrecision,
  integer,
  primaryKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Drizzle reference table for the partitioned `items` parent table.
export const items = pgTable(
  'items',
  {
    item_network: text('item_network').notNull(),
    item_domain: text('item_domain').notNull(),
    item_type: text('item_type').notNull(),
    item_id: uuid('item_id').defaultRandom().notNull(),

    item_instance_url: text('item_instance_url').notNull(),
    item_schema_url: text('item_schema_url').notNull(),

    item_state: jsonb('item_state')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    item_private_state: text('item_private_state').notNull().default(''),
    item_latitude: doublePrecision('item_latitude'),
    item_longitude: doublePrecision('item_longitude'),
    created_by: text('created_by').notNull(),

    created_at: timestamp('created_at')
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updated_at: timestamp('updated_at')
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    lifecycle_status: text('lifecycle_status').notNull().default('draft'),
    completion_pct: integer('completion_pct').notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.item_network,
        table.item_domain,
        table.item_type,
        table.item_id,
      ],
    }),
  ]
);
