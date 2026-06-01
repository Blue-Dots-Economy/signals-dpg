import {
  pgTable,
  text,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const userNetwork = pgTable(
  'user_network',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    network: text('network').notNull(),
    domain: text('domain').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.network] }),
    index('user_network_by_binding_idx').on(t.network, t.domain),
  ],
);
