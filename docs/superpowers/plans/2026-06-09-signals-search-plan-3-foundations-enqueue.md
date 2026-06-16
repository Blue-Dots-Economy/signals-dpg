# Signals Search — Plan 3: Signals-DPG Foundations + Enqueue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Signals-DPG "search-ready": add the `pgvector`/`postgis` extensions and the `item_search` table to the authoritative schema, add `vectorize` markers to the example network schemas, and emit a best-effort Redis event on every item create/update/delete so the `signals-search` worker can index in near-real-time.

**Architecture:** DDL goes in the authoritative bundled `schema.sql` (single source of truth for the `dpg` DB, applied by the deploy migrate-job). The enqueue reuses the existing `ioredis` singleton and mirrors the existing best-effort `invalidateItemFetchCache().catch(warn)` pattern, so it can never break the item write. The contract (stream name + fields) matches `signals-search` Plan 1.

**Tech Stack:** TypeScript, Fastify, Drizzle, `ioredis`, Vitest. Schema bundling via `scripts/generate-schema-bundle.mjs`.

**Master tracker:** Blue-Dots-Economy/Signals-DPG#171. **Spec:** https://github.com/Blue-Dots-Economy/signals-search/blob/feat/search-engine-v1/docs/2026-06-09-signals-search-engine-design.md

**Cross-plan contract (must match signals-search Plan 1):**
- Stream `signals:item-events`; fields `item_network, item_domain, item_type, item_id, op` (`upsert|delete`), `occurred_at` (ISO).
- `item_search` DDL identical to signals-search `src/db/migrations/0001_item_search.sql` (no FK in V1; deletes handled by the `delete` event + sweep).

---

### Task 1: Add `vector`/`postgis` extensions + `item_search` DDL to the authoritative schema

**Files:**
- Modify: `packages/database/src/utils/sql_scripts/create_items.sql` (extensions at top, lines 1-3; append `item_search` after the items table)
- Regenerate: `apps/api/db/postgres/schema.sql` (via `pnpm schema:bundle`)

- [ ] **Step 1: Add the two extensions** — edit the top of `packages/database/src/utils/sql_scripts/create_items.sql` so the extension block reads:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;
```

- [ ] **Step 2: Append the `item_search` table** to the END of `packages/database/src/utils/sql_scripts/create_items.sql` (identical to the signals-search dev migration; idempotent):

```sql
-- ── item_search (Signals search engine V1) ──────────────────────────────────
-- Search/discovery index maintained by the signals-search service.
-- DDL authority lives here (shared dpg DB); the signals-search repo carries an
-- identical dev/test mirror. No FK to items: deletes are handled by the
-- 'delete' item-event + the reconciliation sweep.
CREATE TABLE IF NOT EXISTS item_search (
  item_network     text NOT NULL,
  item_domain      text NOT NULL,
  item_type        text NOT NULL,
  item_id          uuid NOT NULL,
  embedding        vector(1024),
  geo              geography(MultiPoint, 4326),
  lifecycle_status text NOT NULL DEFAULT 'draft',
  model_version    text,
  content_hash     text,
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_network, item_domain, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS item_search_embedding_hnsw
  ON item_search USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS item_search_geo_gist
  ON item_search USING gist (geo);
CREATE INDEX IF NOT EXISTS item_search_live
  ON item_search (item_network, item_domain, item_type) WHERE lifecycle_status = 'live';
```

- [ ] **Step 3: Regenerate the bundle**

Run: `pnpm schema:bundle`
Expected: `apps/api/db/postgres/schema.sql` updated; the new extensions + `item_search` block now appear in it.

- [ ] **Step 4: Verify bundle freshness (the CI check)**

Run: `pnpm schema:bundle:check`
Expected: exits 0 / "no drift" (the committed bundle matches the regenerated output).

- [ ] **Step 5: Verify the bundle contains the new objects**

Run: `grep -c "CREATE EXTENSION IF NOT EXISTS vector" apps/api/db/postgres/schema.sql && grep -c "CREATE TABLE IF NOT EXISTS item_search" apps/api/db/postgres/schema.sql`
Expected: prints `1` and `1`.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/utils/sql_scripts/create_items.sql apps/api/db/postgres/schema.sql
git commit -m "feat(db): add pgvector/postgis + item_search to authoritative schema"
```

---

### Task 2: `INGEST_STREAM` env var (config + turbo)

**Files:**
- Modify: `packages/config/src/secrets.ts` (`DatabaseSecretsSchema`, ~line 67-79)
- Modify: `apps/api/src/config.ts` (`databasesConfig`, ~line 68-82)
- Modify: `turbo.json` (`globalPassThroughEnv`)
- Test: `packages/config/src/__tests__/ingest_stream.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/config/src/__tests__/ingest_stream.test.ts
import { describe, it, expect } from 'vitest';
import { DatabaseSecretsSchema } from '../secrets.js';

const base = {
  POSTGRES_USER: 'dpg',
  POSTGRES_PASSWORD: 'password12',
  POSTGRES_DB: 'dpg',
  REDIS_PASSWORD: 'redispw',
};

describe('DatabaseSecretsSchema INGEST_STREAM', () => {
  it('defaults to signals:item-events', () => {
    const parsed = DatabaseSecretsSchema.parse(base);
    expect(parsed.INGEST_STREAM).toBe('signals:item-events');
  });

  it('accepts an override', () => {
    const parsed = DatabaseSecretsSchema.parse({ ...base, INGEST_STREAM: 'custom:stream' });
    expect(parsed.INGEST_STREAM).toBe('custom:stream');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @repo/config test ingest_stream` *(use the actual config package name from `packages/config/package.json`; if it has no test script, run `pnpm vitest run packages/config/src/__tests__/ingest_stream.test.ts` from repo root)*
Expected: FAIL — `INGEST_STREAM` is `undefined`.

- [ ] **Step 3: Add the field** to `DatabaseSecretsSchema` in `packages/config/src/secrets.ts` (append inside the object, after `REDIS_PORT`):

```typescript
  INGEST_STREAM: z.string().default('signals:item-events'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/config/src/__tests__/ingest_stream.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Expose it in `databasesConfig`** — in `apps/api/src/config.ts`, add to the `databasesConfig` object (alongside `redis_url`):

```typescript
  ingest_stream: databases.INGEST_STREAM,
```

- [ ] **Step 6: Add to `turbo.json` `globalPassThroughEnv`** — insert `"INGEST_STREAM"` into the array (e.g. after `"INSTANCE_NAME"`):

```json
    "INGEST_STREAM",
```

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter api typecheck
git add packages/config/src/secrets.ts packages/config/src/__tests__/ingest_stream.test.ts apps/api/src/config.ts turbo.json
git commit -m "feat(config): add INGEST_STREAM env (default signals:item-events)"
```

---

### Task 3: `publishItemEvent` util (best-effort XADD)

**Files:**
- Create: `apps/api/src/utils/publish_item_event.ts`
- Test: `apps/api/src/utils/__tests__/publish_item_event.test.ts`

- [ ] **Step 1: Write the failing test** (mock the redis singleton + config)

```typescript
// apps/api/src/utils/__tests__/publish_item_event.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const xadd = vi.fn();
vi.mock('@api/db/secondary/redis', () => ({ redis: { xadd } }));
vi.mock('@api/src/config', () => ({ databasesConfig: { ingest_stream: 'signals:item-events' } }));

import { publishItemEvent } from '../publish_item_event.js';

beforeEach(() => xadd.mockReset());

const evt = {
  item_network: 'purple_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
  item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
  op: 'upsert' as const,
};

describe('publishItemEvent', () => {
  it('XADDs the event fields to the configured stream', async () => {
    xadd.mockResolvedValueOnce('1-0');
    await publishItemEvent(evt);
    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('signals:item-events');
    expect(args[1]).toBe('*');
    // field/value pairs include our keys
    expect(args).toContain('item_id');
    expect(args).toContain('5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf');
    expect(args).toContain('op');
    expect(args).toContain('upsert');
  });

  it('never throws when redis rejects (best-effort)', async () => {
    xadd.mockRejectedValueOnce(new Error('redis down'));
    const logger = { warn: vi.fn() };
    await expect(publishItemEvent(evt, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/utils/__tests__/publish_item_event.test.ts`
Expected: FAIL — `Cannot find module '../publish_item_event.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/utils/publish_item_event.ts
import { redis } from '@api/db/secondary/redis';
import { databasesConfig } from '@api/src/config';

export type ItemEventOp = 'upsert' | 'delete';

export interface ItemEvent {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  op: ItemEventOp;
}

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * Best-effort publish of an item mutation to the search ingestion stream.
 * Mirrors invalidateItemFetchCache: never throws — a Redis outage must not
 * break the item write. The signals-search reconciliation sweep is the backstop.
 */
export async function publishItemEvent(event: ItemEvent, logger?: WarnLogger): Promise<void> {
  try {
    await redis.xadd(
      databasesConfig.ingest_stream,
      '*',
      'item_network', event.item_network,
      'item_domain', event.item_domain,
      'item_type', event.item_type,
      'item_id', event.item_id,
      'op', event.op,
      'occurred_at', new Date().toISOString(),
    );
  } catch (err) {
    (logger ?? console).warn({ err, item_id: event.item_id }, 'publishItemEvent failed (best-effort)');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/api/src/utils/__tests__/publish_item_event.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/publish_item_event.ts apps/api/src/utils/__tests__/publish_item_event.test.ts
git commit -m "feat: best-effort publishItemEvent (XADD to ingestion stream)"
```

---

### Task 4: Wire enqueue into create / update / delete handlers

**Files:**
- Modify: `apps/api/src/routes/v1/item/create_item.ts` (~line 165-167)
- Modify: `apps/api/src/routes/v1/item/update_item.ts` (~line 60-62)
- Modify: `apps/api/src/routes/v1/item/delete_item.ts` (delete `.returning()` + ~line 73-75)

- [ ] **Step 1: Create — add the enqueue** in `create_item.ts`, immediately before the `invalidateItemFetchCache(...)` call. The `created` row exposes `itemNetwork/itemDomain/itemType/itemId` (camelCase):

```typescript
    await publishItemEvent(
      {
        item_network: created.itemNetwork,
        item_domain: created.itemDomain,
        item_type: created.itemType,
        item_id: created.itemId,
        op: 'upsert',
      },
      request.log,
    );
```

Add the import at the top of the file:

```typescript
import { publishItemEvent } from '@api/src/utils/publish_item_event';
```

- [ ] **Step 2: Update — add the enqueue** in `update_item.ts`, immediately before its `invalidateItemFetchCache(...)` call. The `updated` row exposes snake_case fields:

```typescript
    await publishItemEvent(
      {
        item_network: updated.item_network,
        item_domain: updated.item_domain,
        item_type: updated.item_type,
        item_id: updated.item_id,
        op: 'upsert',
      },
      request.log,
    );
```

Add the same import at the top.

- [ ] **Step 3: Delete — first add `item_type` to the `.returning()`** in `delete_item.ts` (the event needs it):

```typescript
      .returning({
        item_id: items.item_id,
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
      });
```

Then add the enqueue immediately before its `invalidateItemFetchCache(...)` call:

```typescript
    await publishItemEvent(
      {
        item_network: result[0].item_network,
        item_domain: result[0].item_domain,
        item_type: result[0].item_type,
        item_id: result[0].item_id,
        op: 'delete',
      },
      request.log,
    );
```

Add the same import at the top.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter api typecheck`
Expected: clean (no type errors).

- [ ] **Step 5: Run the item route unit tests**

Run: `pnpm --filter api test`
Expected: PASS — existing item create/update/delete unit tests still green (the enqueue is best-effort and `redis` is a no-op/unconnected singleton in unit tests; if any unit test newly fails because it asserts exact side-effects, mock `@api/src/utils/publish_item_event` in that test). Integration tests (`test:integration`) remain gated on a running DB/Redis.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/item/create_item.ts apps/api/src/routes/v1/item/update_item.ts apps/api/src/routes/v1/item/delete_item.ts
git commit -m "feat: enqueue item events on create/update/delete (best-effort)"
```

---

### Task 5: Add `vectorize` markers to example schemas

**Files:**
- Modify: `examples/schemas/purple_dot/network.json` (provider `profile_1.0`: `service_details`, `services_offered`)
- Test: `examples/schemas/__tests__/vectorize_markers.test.ts` *(or co-locate under `apps/api/src/__tests__/` if `examples/` is outside the test roots — see Step 2)*

- [ ] **Step 1: Add markers** — in `examples/schemas/purple_dot/network.json`, on the provider `profile_1.0` properties, add `"vectorize": true` (and a weight on the free-text one). The properties become:

```json
"service_details": {
  "type": "string",
  "title": "Service Details",
  "description": "Share more about the service, opportunity, or support provided",
  "minLength": 1,
  "vectorize": true,
  "vector_weight": 2
},
```

```json
"services_offered": {
  "type": "array",
  "title": "Services Offered",
  "items": { "type": "string" },
  "vectorize": true
},
```

(Leave all `"private": true` properties — e.g. `contact_name`, `contact_phone` — WITHOUT a `vectorize` marker. The signals-search resolver rejects `vectorize` on private props.)

- [ ] **Step 2: Write the test** (asserts the markers parse and land on public fields only). Place it under the api test root and import the JSON by relative path:

```typescript
// apps/api/src/__tests__/purple_dot_vectorize.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../../../../examples/schemas/purple_dot/network.json');

type Prop = { private?: boolean; vectorize?: boolean; vector_weight?: number };

describe('purple_dot vectorize markers', () => {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const provider = cfg.domains.find((d: { id?: string }) => d.id === 'provider');
  const props: Record<string, Prop> = provider.item_schemas['profile_1.0'].properties;

  it('marks the two public free-text fields for vectorization', () => {
    expect(props.service_details.vectorize).toBe(true);
    expect(props.service_details.vector_weight).toBe(2);
    expect(props.services_offered.vectorize).toBe(true);
  });

  it('never marks a private property for vectorization', () => {
    for (const [, prop] of Object.entries(props)) {
      if (prop.private === true) expect(prop.vectorize).not.toBe(true);
    }
  });
});
```

(Adjust the relative `file` path depth if the api package root differs; verify with `node -e` that the path resolves before running.)

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run apps/api/src/__tests__/purple_dot_vectorize.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Sanity-check the config still loads** (AJV `strict:false` must accept the unknown markers)

Run: `pnpm --filter api test`
Expected: PASS — no schema-loading/validation test regresses from the new markers.

- [ ] **Step 5: Commit**

```bash
git add examples/schemas/purple_dot/network.json apps/api/src/__tests__/purple_dot_vectorize.test.ts
git commit -m "feat: vectorize markers on purple_dot provider public fields"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan 3 portion):** extensions + `item_search` DDL in authoritative schema ✓ (Task 1); `INGEST_STREAM` env wired in both required places ✓ (Task 2); best-effort enqueue util ✓ (Task 3); wired into all three mutation paths, `op` correct, `item_type` added to delete returning ✓ (Task 4); `vectorize` markers on public fields only ✓ (Task 5).
- **Contract consistency with Plan 1:** `item_search` DDL, stream name `signals:item-events`, and event fields/`op` values match signals-search Plan 1 exactly. **Decision:** no FK on `item_search` in V1 (deletes flow through the `delete` event + sweep) — keeps the authoritative DDL identical to the dev mirror and avoids FK-to-partitioned-table edge cases. (The spec mentions an optional FK cascade; intentionally deferred.)
- **Best-effort guarantee:** `publishItemEvent` swallows + logs (Task 3 test 2), and callers pass `request.log`; a Redis outage cannot break an item write — same guarantee as `invalidateItemFetchCache`.
- **Placeholder scan:** the only adjust-on-the-ground items are the config package's exact test command (Task 2 Step 2) and the relative JSON path depth (Task 5) — both call out how to verify rather than guessing silently.
- **Phase note:** Tasks 1, 2, 5 are Phase-1 foundations (can merge before signals-search exists); Tasks 3-4 are Phase-3 enqueue (depend on the Plan-1 consumer existing to have effect, but are safe to merge earlier — events simply accumulate in the stream / are trimmed).
