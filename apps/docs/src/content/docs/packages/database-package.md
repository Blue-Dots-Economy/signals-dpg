---
title: Database Package
description: What the database package exposes and how to use it.
head: []
---

`packages/database` contains the data-layer contracts shared by the API.

## What it exposes

- `items` reference table
- `item_actions` reference table
- `action_events` reference table
- partition helpers
- SQL scripts for base table creation

## Why reference tables exist

Drizzle does not manage partitioned tables directly the way this project needs, so the package exposes ref tables that match the parent partitioned tables.

## Typical usage

```ts
import { items, ensureItemPartition } from '@dpg/database';
```

The API uses:

- `items` for CRUD queries
- `ensureItemPartition()` before inserting a new item

## SQL files

- `create_items.sql` contains generic parent table DDL
- `examples/create_items_partitions.example.sql` contains example partition definitions only
- `create_actions_events.sql` contains generic parent table DDL for action and event runtime tables
- `examples/create_actions_events_partitions.example.sql` contains example action and event partitions only
- `add_action_owner_columns.sql` upgrades older action/event tables with owner snapshot columns

## Postgres setup flow

The database setup is split into two parts on purpose:

1. Run `create_items.sql`
2. Run your partition creation SQL
3. Start the API, which can create missing runtime partitions through the helpers

The first scripts create the parent partitioned tables and shared indexes. The example scripts create deployment-specific partitions.

If your database already has action/event tables from an earlier version, run `add_action_owner_columns.sql` before using the ownership-enforced action and event fetch APIs.

## Extensions used

`create_items.sql` enables three PostgreSQL extensions:

- `pgcrypto`: used for `gen_random_uuid()` defaults on `item_id` and `event_id`
- `cube`: required by the earthdistance extension
- `earthdistance`: used for geo lookups with `ll_to_earth`, `earth_box`, and `earth_distance`

These extensions are needed before the geo index and distance filters can work.

## Base tables

The package models three parent tables:

- `items`: stores the current item record
- `item_actions`: stores runtime action instances between items
- `action_events`: stores immutable events emitted by actions

Important columns in `items`:

- routing keys: `item_network`, `item_domain`, `item_type`
- record id: `item_id`
- instance fields: `item_instance_url`, `item_schema_url`
- document fields: `item_state`
- geo fields: `item_latitude`, `item_longitude`
- owner field: `created_by`
- timestamps: `created_at`, `updated_at`

`items.created_by` is a foreign key to the Better Auth `user` table. The item APIs do not accept `created_by` from the client. The API derives it from the authenticated user and uses it for item ownership checks on update.

Important columns in `item_actions`:

- partition owner: `partition_network`
- action identity: `action_type`, `action_id`
- action state: `action_status`, `update_count`, `requirements_snapshot`, `remarks`
- source item reference: `source_item_network`, `source_item_domain`, `source_item_type`, `source_item_id`, `source_item_instance_url`
- source owner snapshot: `source_item_owner`
- target item reference: `target_item_network`, `target_item_domain`, `target_item_type`, `target_item_id`, `target_item_instance_url`
- target owner snapshot: `target_item_owner`
- timestamps: `created_at`, `updated_at`

Important columns in `action_events`:

- partition owner: `partition_network`
- event identity: `action_type`, `event_id`
- origin and action state: `origin_instance_domain`, `action_id`, `action_status`, `update_count`
- source item reference: `source_item_network`, `source_item_domain`, `source_item_type`, `source_item_id`, `source_item_instance_url`
- source owner and geo snapshots: `source_item_owner`, `source_item_latitude`, `source_item_longitude`
- target item reference: `target_item_network`, `target_item_domain`, `target_item_type`, `target_item_id`, `target_item_instance_url`
- target owner and geo snapshots: `target_item_owner`, `target_item_latitude`, `target_item_longitude`
- event data: `event_payload`, `remarks`
- timestamp: `created_at`

`source_item_owner` and `target_item_owner` are denormalized snapshots. They let the API answer `GET /api/v1/action/fetch` and `GET /api/v1/event/fetch` for the authenticated user without joining back through remote instances.

`item_actions` has foreign keys back to `items` for both source and target items.

## Event payload and remarks

The current runtime stores domain event data in `event_payload` and operator-visible context in `remarks`.

- `event_payload`: the business event body itself. This is the domain-specific content that describes what happened.
- `remarks`: a short human-readable note for action status updates or mirrored events.

Use `event_payload` for values that matter to the event semantics, for example:

- status transitions
- amounts
- messages
- references used by downstream business logic

As a rule: if changing the field would change the meaning of the event, it belongs in `event_payload`. If it only explains the status transition, it belongs in `remarks`.

## Partition strategy

The schema uses hierarchical list partitioning.

For `items`:

- root table partitions by `item_network`
- network partitions subpartition by `item_domain`
- leaf partition tables are named as `i_p_{network}_{domain}`

For `item_actions` and `action_events`:

- root tables partition by `partition_network`
- network partitions subpartition by `action_type`
- leaf partition tables are named as `a_p_{network}_{action}` and `e_p_{network}_{action}`

This design keeps item rows grouped by network/domain and runtime action/event rows grouped by network/action.

## How the scripts work

### `create_items.sql`

This script creates the partitioned parent tables only. It does not create business-specific partitions.

It also creates shared indexes:

- btree lookup indexes for common filters and ordering
- GIN indexes for event JSONB fields
- a GiST geo index using `ll_to_earth(item_latitude, item_longitude)`

The parent tables are defined with:

```sql
PARTITION BY LIST (item_network)
```

That means rows first route by network. Each network partition then routes by domain.

### `create_items_partitions.example.sql`

This is an example deployment script. It shows concrete network/domain partitions.

It first verifies that:

- `items` exists

Then it creates:

- `i_p_yellowdot`
- `i_p_yellowdot_student`
- `i_p_yellowdot_tutor`

## Runtime partition helpers

The package exports:

- `ensureItemPartition(db, network, domain)`
- `ensureActionPartition(db, network, actionType)`
- `ensureActionEventPartition(db, network, actionType)`

This helper creates missing partitions lazily with `CREATE TABLE IF NOT EXISTS`.

`ensureItemPartition()` creates:

1. `i_p_{network}`
2. `i_p_{network}_{domain}`

`ensureActionPartition()` creates:

1. `a_p_{network}`
2. `a_p_{network}_{action_type}`

`ensureActionEventPartition()` creates:

1. `e_p_{network}`
2. `e_p_{network}_{action_type}`

The helper accepts any non-empty partition key up to 120 characters. It normalizes generated table names by lowercasing the keys, removing non-alphanumeric characters, joining with underscores, and prepending `i_p_`, `a_p_`, or `e_p_`.

## Why query filters matter

Partition pruning only works well when the query includes the partition key columns.

For `items`, the partition key consists of:

- `item_network`
- `item_domain`

For `item_actions` and `action_events`, include `partition_network` and `action_type` when possible.

These keys should be included in `where` clauses to allow PostgreSQL to scan only the relevant partition.

## Example table layout

If you support these network/domain paths:

- `yellow_dot/student`
- `yellow_dot/tutor`

you would expect tables like:

```text
items
i_p_yellowdot
i_p_yellowdot_student
i_p_yellowdot_tutor
```

## Example Drizzle queries

### Insert an item

This matches the API create flow: prepare the partition first, then insert through the `items` reference table.

```ts
import { db } from 'apps/api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';

await ensureItemPartition(db, 'yellow_dot', 'student');

const created = await db
  .insert(items)
  .values({
    item_network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_instance_url: 'student://123',
    item_schema_url: 'https://schemas.example.com/student_profile_v1.json',
    item_state: { name: 'Asha' },
    created_by: 'real_user_id',
    item_latitude: 12.9716,
    item_longitude: 77.5946,
  })
  .returning();
```

### Fetch items with partition-friendly filters

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db } from 'apps/api/db/postgres/drizzle_config';
import { items } from '@dpg/database';

const result = await db
  .select()
  .from(items)
  .where(
    and(
      eq(items.item_network, 'yellow_dot'),
      eq(items.item_domain, 'student'),
      eq(items.item_type, 'profile_1.0')
    )
  )
  .orderBy(sql`${items.created_at} DESC`)
  .limit(20);
```

### Filter by JSONB state

```ts
const result = await db
  .select()
  .from(items)
  .where(
    sql`${items.item_state} @> ${JSON.stringify({ verified: true })}::jsonb`
  );
```

### Geo search using `earthdistance`

```ts
const result = await db
  .select()
  .from(items)
  .where(
    and(
      eq(items.item_network, 'yellow_dot'),
      eq(items.item_domain, 'student'),
      sql`
        earth_box(
          ll_to_earth(${12.9716}, ${77.5946}),
          ${5000}
        ) @> ll_to_earth(${items.item_latitude}, ${items.item_longitude})
      `,
      sql`
        earth_distance(
          ll_to_earth(${12.9716}, ${77.5946}),
          ll_to_earth(${items.item_latitude}, ${items.item_longitude})
        ) <= ${5000}
      `
    )
  );
```

### Insert an action

```ts
import { ensureActionPartition, item_actions } from '@dpg/database';

await ensureActionPartition(db, 'yellow_dot', 'connect');

await db.insert(item_actions).values({
  partition_network: 'yellow_dot',
  action_type: 'connect',
  action_status: 'created',
  update_count: 0,
  source_item_network: 'yellow_dot',
  source_item_domain: 'student',
  source_item_type: 'profile_1.0',
  source_item_id: '11111111-1111-1111-1111-111111111111',
  source_item_instance_url: 'https://student.yellowdot.example.com',
  source_item_owner: 'student_user_id',
  target_item_network: 'yellow_dot',
  target_item_domain: 'tutor',
  target_item_type: 'profile_1.0',
  target_item_id: '22222222-2222-2222-2222-222222222222',
  target_item_instance_url: 'https://tutor.yellowdot.example.com',
  target_item_owner: 'tutor_user_id',
  requirements_snapshot: { subject: 'math', goal: 'board_exam' },
});
```

### Insert an action event

```ts
import { action_events, ensureActionEventPartition } from '@dpg/database';

await ensureActionEventPartition(db, 'yellow_dot', 'connect');

await db.insert(action_events).values({
  partition_network: 'yellow_dot',
  action_type: 'connect',
  origin_instance_domain: 'https://tutor.yellowdot.example.com',
  action_id: '33333333-3333-3333-3333-333333333333',
  action_status: 'created',
  update_count: 0,
  source_item_network: 'yellow_dot',
  source_item_domain: 'student',
  source_item_type: 'profile_1.0',
  source_item_id: '11111111-1111-1111-1111-111111111111',
  source_item_instance_url: 'https://student.yellowdot.example.com',
  source_item_owner: 'student_user_id',
  target_item_network: 'yellow_dot',
  target_item_domain: 'tutor',
  target_item_type: 'profile_1.0',
  target_item_id: '22222222-2222-2222-2222-222222222222',
  target_item_instance_url: 'https://tutor.yellowdot.example.com',
  target_item_owner: 'tutor_user_id',
  event_payload: { status: 'created', remark: 'Action created' },
});
```

### Fetch events for one action

```ts
import { and, desc, eq } from 'drizzle-orm';
import { action_events } from '@dpg/database';

const events = await db
  .select()
  .from(action_events)
  .where(
    and(
      eq(action_events.action_type, 'connect'),
      eq(action_events.partition_network, 'yellow_dot'),
      eq(action_events.action_id, '33333333-3333-3333-3333-333333333333')
    )
  )
  .orderBy(desc(action_events.created_at));
```

## Practical rules

- Always run `create_items.sql` before creating partitions
- Include partition keys in queries whenever possible
- Call `ensureItemPartition()` before inserting items into a new network/domain path
- Treat the Drizzle tables in the package as reference tables for the partitioned parents, not as migration-managed tables
