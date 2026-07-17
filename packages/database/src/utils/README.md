# Partition utilities

Root `CLAUDE.md` calls these "partition-aware query helpers" — that name is misleading. What's actually here is **partition management (DDL)**, not query building:

- `ensureItemPartition(db, network, domain)`, `ensureActionPartition(db, network, actionType)`, `ensureActionEventPartition(db, network, actionType)` lazily `CREATE TABLE ... PARTITION OF` a two-level nested list partition (network → domain, or network → action_type) the first time a given `(network, domain)`/`(network, actionType)` pair is written, and verify the partition is correctly attached via `pg_inherits`. These run on the write path, when a new network/domain (or action type) is first used.

## The actual query-pruning contract is implicit — here's the rule

There is no helper that builds a pruning-safe query for you. **The planner only prunes a partitioned table when the query filters on the partition key columns directly** (`item_network` [+ `item_domain` for items, or `action_type` for actions]). An ad-hoc query against `items`/`item_actions` that omits those filters scans every partition.

Copy the pattern from a real call site rather than re-deriving it: `apps/api/src/utils/item_fetch_runtime.ts:56-57`

```ts
conditions.push(eq(items.item_network, filters.item_network));
conditions.push(eq(items.item_domain, filters.item_domain));
```

If you're writing a new query against `items` or `item_actions`, these two (or three, for actions: network + action_type) `eq()` conditions are non-negotiable — add them even if the rest of your filter would already narrow the result set, because the planner decides whether to prune *before* it knows how selective your other conditions are.
