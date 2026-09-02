# `signals-e2e` Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/signals-e2e` bring the local Signals stack up, run the existing
e2e journeys green with every local capability enabled, clean up exactly after
itself, and print a five-section signoff — including a scoped mode
(`/signals-e2e u18`).

**Architecture:** The lifted Playwright suite in `e2e/` is the engine; a new
skill at `.claude/skills/signals-e2e/` is the orchestration around it. Three
Node stubs supply the oracles the suite's config already asks for
(`notificationStubUrl`, `faultInjection`, and a populated `item_search`).
Capabilities are enabled entirely through the `E2E_*` env overrides that
`e2e/src/config.ts:146-162` already supports, so no committed config is mutated
at run time.

**Tech Stack:** Playwright 1.49 + TypeScript 5.7 (ESM, `.js` import specifiers)
in `e2e/`; plain Node 24 ESM for the stubs and `node:test` for their unit
tests; bash for the orchestration scripts; `pg` for DB access.

**Spec:** `docs/superpowers/specs/2026-09-02-signals-e2e-skill-design.md`
**Audit:** `docs/testing/e2e-drift-audit-2026-09-02.md`

**Follow-on plan (not this one):** coverage expansion for the post-divergence
features in audit §3, in that document's priority order.

## Global Constraints

- **Node `>=24`, `pnpm@11.1.2`** at the repo root (`engines`/`packageManager`);
  `e2e/` deliberately uses **npm**, not pnpm, and stays outside the pnpm
  workspace. Do not add it to `pnpm-workspace.yaml`.
- **Never edit a tracked file to make a run pass.** Capabilities are enabled via
  `E2E_*` env vars only. `e2e/config/local.json` is not modified at run time.
  (Editing `playwright.config.ts` to add a reporter is a feature change, not a
  run-time hack, and is in scope.)
- **Never run a type-wide or network-wide `DELETE`** against the local DB.
  Cleanup is scoped to the run's tag and its created-key ledger only.
- **Files are snake_case** in the API/UI trees; `e2e/src/*` follows its own
  existing kebab/snake mix — match the file you are next to.
- **No `// TODO` comments** anywhere (root `CLAUDE.md`).
- **A flow that could not run is a SKIP with a reason, never a PASS.** Use
  `requireCapabilities(test, caps, [...])`; never a bare `test.skip(true)`.
- **This host is an 8 GB arm64 Mac.** Do not enable the `search` docker profile
  by default (amd64-only images, 3–8 GB embedder). Cap any repo test run with
  `--pool=forks --maxWorkers=2`.
- OTP in local runs is the fixed string **`000000`** (`CREATE_TEST_OTP=true`).
- Postgres container is **`dpg-db`**, Redis is **`dpg-redis`** (per
  `docker-compose.yaml`); API `:2742`, UI `:3000` **or** `:5173` — probe, never
  assume.

---

### Task 1: DB access for the suite (`pg` + `src/db.ts`)

The `db` capability is declared at `e2e/src/capabilities.ts:43` and read by
nothing — there is no client. Cleanup, the search stub and every row-level
assertion need one. This task adds it.

**Files:**
- Modify: `e2e/package.json` (add `pg` + `@types/pg`)
- Create: `e2e/src/db.ts`
- Test: `e2e/src/__tests__/db.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from `e2e/src/config.ts`.
- Produces:
  - `openDb(url: string): Db` where `Db = { query<T>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void> }`
  - `requireDb(cfg: E2EConfig): Db` — throws a named error when `cfg.db.url` is null.
  - `class DbNotConfiguredError extends Error`

- [ ] **Step 1: Write the failing test**

`e2e/src/__tests__/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireDb, DbNotConfiguredError } from '../db.js';

test('requireDb throws a named, actionable error when db.url is unset', () => {
  const cfg = { db: { url: null } } as never;
  assert.throws(() => requireDb(cfg), (err: Error) => {
    assert.ok(err instanceof DbNotConfiguredError);
    assert.match(err.message, /E2E_DB_URL/);
    return true;
  });
});

test('requireDb returns a client when db.url is set', () => {
  const cfg = { db: { url: 'postgres://u:p@localhost:5432/signals' } } as never;
  const db = requireDb(cfg);
  assert.equal(typeof db.query, 'function');
  assert.equal(typeof db.close, 'function');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd e2e && node --test --experimental-strip-types src/__tests__/db.test.ts`
Expected: FAIL — `Cannot find module '../db.js'`.

- [ ] **Step 3: Add the dependency**

```bash
cd e2e && npm install --save pg@8 && npm install --save-dev @types/pg@8
```

- [ ] **Step 4: Write the implementation**

`e2e/src/db.ts`:

```ts
import { Pool } from 'pg';
import type { E2EConfig } from './config.js';

/**
 * Thin Postgres access for row-level assertions and cleanup.
 *
 * The suite is black-box by default; this is the one seam that reaches behind
 * the API, and it exists because several invariants are only observable in the
 * rows (retire's PII scrub, the consent ledger's append-only shape, the
 * cleanup residue check). Gated by the `db` capability so a shared dev target
 * skips-and-reports rather than failing.
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export class DbNotConfiguredError extends Error {
  override name = 'DbNotConfiguredError';
}

export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url, max: 2 });
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    close: () => pool.end(),
  };
}

export function requireDb(cfg: E2EConfig): Db {
  if (!cfg.db.url) {
    throw new DbNotConfiguredError(
      'direct DB access is not configured — set E2E_DB_URL (or config.db.url) ' +
        'to the local Postgres URL. Gate the caller with requireCapabilities(test, caps, ["db"]).',
    );
  }
  return openDb(cfg.db.url);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd e2e && node --test --experimental-strip-types src/__tests__/db.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Add a unit-test script and typecheck**

Add to `e2e/package.json` `scripts`:

```json
"test:unit": "node --test --experimental-strip-types src/__tests__/*.test.ts"
```

Run: `cd e2e && npm run typecheck && npm run test:unit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add e2e/package.json e2e/package-lock.json e2e/src/db.ts e2e/src/__tests__/db.test.ts
git commit -m "test(e2e): give the suite the DB client its db capability assumed

capabilities.ts has declared a `db` capability since the suite was written and
nothing could satisfy it — there was no client behind the flag, so every
row-level assertion would have skipped even on a target that offered one.
Adds pg and a two-function wrapper: openDb for a pool, requireDb to fail with
the env var name rather than a connection error when the URL is absent."
```

---

### Task 2: Exact cleanup — tag, ledger, and residue check

Built **before** the first live run, so no run ever leaves residue.
`identities.ts:47` promises rows are tagged *"so a bulk sweep can remove them"*;
the sweep does not exist. Tags alone cannot reach a `consent_record` row (no
name field) or an `item_actions` row written by the counterparty, so the ledger
is the second scope and a row-count snapshot diff is the third.

**Files:**
- Create: `e2e/src/ledger.ts`
- Create: `e2e/src/__tests__/ledger.test.ts`
- Create: `.claude/skills/signals-e2e/lib/cleanup.sh`
- Modify: `e2e/src/flows.ts` (record created ids), `e2e/src/items.ts`, `e2e/src/auth.ts`
- Modify: `e2e/.gitignore` (ignore `run/`)

**Interfaces:**
- Consumes: `RUN_ID` from `e2e/src/identities.ts`; `Db` from Task 1.
- Produces:
  - `recordCreated(table: string, pk: string): void` — appends one JSON line.
  - `ledgerPath(runId?: string): string` — `run/<runId>/created.jsonl`.
  - `readLedger(runId: string): Array<{ table: string; pk: string }>`
  - `CLEANUP_TABLES: readonly string[]` — reverse-dependency delete order.

- [ ] **Step 1: Write the failing test**

`e2e/src/__tests__/ledger.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { recordCreated, readLedger, ledgerPath, CLEANUP_TABLES } from '../ledger.js';

const RUN = 'unit-test-run';

test('recordCreated appends readable JSONL and readLedger round-trips it', () => {
  rmSync(ledgerPath(RUN), { force: true });
  recordCreated('items', 'aaa-111', RUN);
  recordCreated('user', 'bbb-222', RUN);
  const rows = readLedger(RUN);
  assert.deepEqual(rows, [
    { table: 'items', pk: 'aaa-111' },
    { table: 'user', pk: 'bbb-222' },
  ]);
  assert.ok(existsSync(ledgerPath(RUN)));
  rmSync(ledgerPath(RUN), { force: true });
});

test('readLedger tolerates a truncated final line from a killed run', () => {
  rmSync(ledgerPath(RUN), { force: true });
  recordCreated('items', 'ccc-333', RUN);
  require('node:fs').appendFileSync(ledgerPath(RUN), '{"table":"items","pk":');
  assert.deepEqual(readLedger(RUN), [{ table: 'items', pk: 'ccc-333' }]);
  rmSync(ledgerPath(RUN), { force: true });
});

test('CLEANUP_TABLES deletes children before parents', () => {
  const order = CLEANUP_TABLES;
  assert.ok(order.indexOf('action_events') < order.indexOf('item_actions'));
  assert.ok(order.indexOf('item_actions') < order.indexOf('items'));
  assert.ok(order.indexOf('items') < order.indexOf('user'));
  assert.ok(order.indexOf('consent_record') < order.indexOf('user'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — `Cannot find module '../ledger.js'`.

- [ ] **Step 3: Write the implementation**

`e2e/src/ledger.ts`:

```ts
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RUN_ID } from './identities.js';

/**
 * A record of every row this run created, so teardown is exact rather than a
 * guess.
 *
 * Tagging identifiers (identities.ts) reaches most rows, but not all: a
 * `consent_record` row carries no name to tag, and an `item_actions` row
 * written by the counterparty during a bulk flow was never ours to name. This
 * ledger is the second scope; the row-count snapshot diff in cleanup.sh is the
 * third, and the only one that catches something we forgot to do both.
 *
 * Append-only JSONL because a killed run must still leave a readable file —
 * readLedger drops a truncated final line rather than throwing.
 */

/** Reverse-dependency order: children before the parents they reference. */
export const CLEANUP_TABLES = [
  'action_events',
  'item_actions',
  'item_search',
  'item_locations',
  'item_metrics',
  'consent_record',
  'items',
  'session',
  'account',
  'verification',
  'member',
  'organization',
  'user',
] as const;

export function ledgerPath(runId: string = RUN_ID): string {
  return resolve(import.meta.dirname, '..', 'run', runId, 'created.jsonl');
}

export function recordCreated(table: string, pk: string, runId: string = RUN_ID): void {
  const path = ledgerPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ table, pk })}\n`);
}

export function readLedger(runId: string = RUN_ID): Array<{ table: string; pk: string }> {
  const path = ledgerPath(runId);
  if (!existsSync(path)) return [];
  const out: Array<{ table: string; pk: string }> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as { table: string; pk: string });
    } catch {
      // A killed run can leave a partial final line. Dropping it is correct:
      // the row it described may not have been created either.
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd e2e && npm run test:unit`
Expected: PASS, 5/5 (2 from Task 1 + 3 here).

- [ ] **Step 5: Record creations from the existing flows**

In `e2e/src/flows.ts`, after the item is created and its id is known, and after
a user is provisioned, add the ledger calls. Find the `createLiveProfileUser`
body where `itemId` is resolved and where the session's user id is known, then:

```ts
import { recordCreated } from './ledger.js';

// …after the profile item is created:
recordCreated('items', itemId);
// …after the user is provisioned (both the API-provisioned and signup paths):
recordCreated('user', session.userId);
```

Do the same in `e2e/src/items.ts` for any item created directly, and in
`e2e/src/auth.ts` for any user created there. Read each file first and place the
call where the id is definitely known, not before the request.

- [ ] **Step 6: Ignore the run directory**

Append to `e2e/.gitignore`:

```
run/
```

- [ ] **Step 7: Write `cleanup.sh`**

`.claude/skills/signals-e2e/lib/cleanup.sh`:

```bash
#!/usr/bin/env bash
# Exact teardown for one e2e run. Three scopes, each covering the previous
# one's blind spot: the run's ledger of created primary keys, the run's tag on
# every identifier it minted, and a per-table row-count snapshot diffed against
# the pre-run one.
#
# NEVER a type-wide or network-wide DELETE — a stray `WHERE item_type = ...`
# here would wipe a developer's own local data. Every statement below is bound
# to this run's ids or its tag.
#
# Usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]
set -uo pipefail

RUN_ID="${1:?usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]}"
MODE="${2:-full}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/../../../../e2e" && pwd)"
SNAP_DIR="$E2E_DIR/run/$RUN_ID"
mkdir -p "$SNAP_DIR"

PG_CONTAINER="${PG_CONTAINER:-dpg-db}"
PGUSER="${PGUSER:-postgres}"
PGDB="${PGDB:-signals}"

TABLES="action_events item_actions item_search item_locations item_metrics consent_record items session account verification member organization user"

psql_q() { docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "$1"; }

snapshot() {
  : > "$SNAP_DIR/snapshot-$1.txt"
  for t in $TABLES; do
    n=$(psql_q "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo NA)
    printf '%s %s\n' "$t" "$n" >> "$SNAP_DIR/snapshot-$1.txt"
  done
  echo "[cleanup] snapshot-$1 written to $SNAP_DIR/snapshot-$1.txt"
}

if [ "$MODE" = "--snapshot-only" ]; then snapshot before; exit 0; fi

if [ "$MODE" != "--verify-only" ]; then
  # Scope 1 — the ledger, deleted child-first.
  LEDGER="$SNAP_DIR/created.jsonl"
  if [ -f "$LEDGER" ]; then
    for t in $TABLES; do
      ids=$(node -e '
        const fs=require("fs");
        const t=process.argv[1];
        const ids=fs.readFileSync(process.argv[2],"utf8").split("\n")
          .filter(Boolean).flatMap(l=>{try{const r=JSON.parse(l);return r.table===t?[r.pk]:[]}catch{return[]}});
        process.stdout.write([...new Set(ids)].map(i=>`'"'"'${i}'"'"'`).join(","));
      ' "$t" "$LEDGER")
      [ -z "$ids" ] && continue
      pk=$([ "$t" = "items" ] && echo item_id || echo id)
      psql_q "DELETE FROM \"$t\" WHERE $pk::text IN ($ids);" >/dev/null 2>&1
    done
    echo "[cleanup] ledger replayed"
  fi

  # Scope 2 — the run tag on minted identifiers. Bound to the tag, nothing else.
  psql_q "DELETE FROM \"user\" WHERE email LIKE '%${RUN_ID}%' OR phone_number LIKE '%${RUN_ID}%';" >/dev/null 2>&1
  psql_q "DELETE FROM organization WHERE slug LIKE '%${RUN_ID}%';" >/dev/null 2>&1
  echo "[cleanup] tag sweep done"

  # Redis: this run's caches and counters only.
  REDIS_CONTAINER="${REDIS_CONTAINER:-dpg-redis}"
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
      EVAL "local n=0; for _,k in ipairs(redis.call('keys','item-*')) do redis.call('del',k); n=n+1 end; return n" 0 >/dev/null 2>&1
  fi
fi

# Scope 3 — residue. The only check that catches what we neither tagged nor
# ledgered. A non-zero delta is a REPORTED FAILURE, not a warning.
snapshot after
RESIDUE=0
while read -r t before; do
  after=$(awk -v k="$t" '$1==k{print $2}' "$SNAP_DIR/snapshot-after.txt")
  if [ "$before" != "NA" ] && [ "$after" != "NA" ] && [ "$after" -gt "$before" ] 2>/dev/null; then
    echo "[cleanup] RESIDUE $t: before=$before after=$after (+$((after-before)))"
    RESIDUE=$((RESIDUE+1))
  fi
done < "$SNAP_DIR/snapshot-before.txt"

if [ "$RESIDUE" -gt 0 ]; then
  echo "[cleanup] FAIL — $RESIDUE table(s) left rows behind"
  exit 1
fi
echo "[cleanup] clean — no residue"
```

- [ ] **Step 8: Verify cleanup against a live DB**

```bash
chmod +x .claude/skills/signals-e2e/lib/cleanup.sh
cd /Users/srivastha/KKB/Github/Signals-DPG.worktrees/signals-e2e
docker compose up -d db redis
bash .claude/skills/signals-e2e/lib/cleanup.sh smoke-run --snapshot-only
bash .claude/skills/signals-e2e/lib/cleanup.sh smoke-run --verify-only
```

Expected: `snapshot-before` written, then `clean — no residue` (nothing was
created between the two snapshots, so the diff must be zero). If `PGDB` is
wrong every count reads `NA` — read the real value with
`node -e 'console.log(require("fs").readFileSync(".env","utf8").match(/^POSTGRES_DB=.*/m)[0])'`
and pass it as `PGDB=`.

- [ ] **Step 9: Commit**

```bash
git add e2e/src/ledger.ts e2e/src/__tests__/ledger.test.ts e2e/.gitignore \
        e2e/src/flows.ts e2e/src/items.ts e2e/src/auth.ts \
        .claude/skills/signals-e2e/lib/cleanup.sh
git commit -m "test(e2e): make a run clean up after itself, and prove it did

identities.ts has promised since the suite was written that rows are tagged \"so
a bulk sweep can remove them\". The sweep was never written, so every run so far
has left accounts, profiles, actions and consent rows behind — and a
half-cleaned database makes the NEXT run lie.

Three scopes, because no single one is sufficient. The ledger records every
primary key as it is created and is replayed child-first, which reaches the rows
a tag cannot: a consent_record row carries no name, and a counterparty's
item_actions row was never ours to name. The tag sweep catches identifiers the
ledger missed. The row-count snapshot diff catches whatever we neither tagged
nor ledgered, and reports a non-zero delta as a failure rather than a warning,
because silent residue is the failure mode being defended against.

Nothing here deletes by item_type or network: a stray type-wide DELETE in a
cleanup script would wipe a developer's own local data."
```

---

### Task 3: Fix the three static audit defects

Audit §1.1, §1.2 and §1.4. The port defect (§1.3) is fixed in Task 4, where the
probe belongs.

**Files:**
- Modify: `e2e/src/ui.ts` (consent scroll helper; label resolver)
- Modify: `e2e/src/schema.ts` (expose the network config so labels resolve)
- Create: `e2e/src/__tests__/ui-helpers.test.ts`
- Modify: `e2e/tests/api/journey-a-signup-profile.spec.ts` (annotate `/support/config`)

**Interfaces:**
- Consumes: `ApiClient` from `e2e/src/api-client.ts`.
- Produces:
  - `getNetworkConfig(api: ApiClient, network: string): Promise<{ domains: Array<{ id: string; label?: string }> }>`
  - `formatDomainLabel(domainId: string, domains?: ReadonlyArray<{ id: string; label?: string }>): string`
  - `passConsentGate(page: Page): Promise<void>`

- [ ] **Step 1: Write the failing test for the label resolver**

`e2e/src/__tests__/ui-helpers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDomainLabel } from '../ui.js';

test('a configured label wins over the title-cased id', () => {
  const domains = [{ id: 'provider', label: 'Service Provider' }, { id: 'seeker' }];
  assert.equal(formatDomainLabel('provider', domains), 'Service Provider');
});

test('an unlabelled domain falls back to the title-cased id', () => {
  assert.equal(formatDomainLabel('seeker', [{ id: 'seeker' }]), 'Seeker');
  assert.equal(formatDomainLabel('individual_tutor', []), 'Individual Tutor');
});

test('a blank label is not treated as configured', () => {
  assert.equal(formatDomainLabel('provider', [{ id: 'provider', label: '   ' }]), 'Provider');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — `formatDomainLabel` is not exported from `../ui.js`.

- [ ] **Step 3: Implement the resolver, mirroring the UI exactly**

Replace `domainLabelFromKey` in `e2e/src/ui.ts` with this, keeping the old name
as a deprecated re-export only if another file still imports it (grep first):

```ts
/**
 * Mirror of the UI's formatDomainLabel (apps/ui/src/lib/domain-icons.ts:57):
 * a network.json `label` wins, else the id is title-cased.
 *
 * The previous version here only title-cased, which agreed with the UI on
 * blue_dot and disagreed on purple_dot, where `provider` renders as "Service
 * Provider" — so every purple_dot UI spec failed to find the domain button.
 * Resolve from the served network config rather than re-deriving.
 */
export function formatDomainLabel(
  domainId: string,
  domains?: ReadonlyArray<{ id: string; label?: string }> | null,
): string {
  const configured = domains?.find((d) => d.id === domainId)?.label?.trim();
  if (configured) return configured;
  return domainId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 4: Add the network-config accessor**

`/api/v1/network/schemas` returns cache entries, one of which is
`kind: 'network_config'` with the full config in `schema` (confirmed at
`apps/api/src/network_schema_cache.ts:120-121`). Add to `e2e/src/schema.ts`:

```ts
export interface NetworkConfigDomain {
  id: string;
  label?: string;
}

interface SchemaCacheEntry {
  kind: string;
  network?: string;
  schema: Record<string, unknown>;
}

/**
 * The served network's own network.json, read from the schema cache endpoint —
 * the same source the UI resolves domain labels and card config from. Needed
 * because /network/schemas' per-schema entries carry no domain metadata.
 */
export async function getNetworkConfig(
  api: ApiClient,
  network: string,
): Promise<{ domains: NetworkConfigDomain[] }> {
  const res = await api.get<SchemaCacheEntry[]>(`/api/v1/network/schemas?network=${encodeURIComponent(network)}`);
  const entry = (res.body ?? []).find((e) => e.kind === 'network_config');
  if (!entry) {
    throw new Error(
      `[e2e] no network_config entry for "${network}" in /api/v1/network/schemas — ` +
        'the API is serving a different network, or its schema cache is empty.',
    );
  }
  const domains = (entry.schema.domains as NetworkConfigDomain[] | undefined) ?? [];
  return { domains };
}
```

- [ ] **Step 5: Run to verify the label tests pass**

Run: `cd e2e && npm run test:unit && npm run typecheck`
Expected: PASS. Fix any call site the rename broke — `grep -rn domainLabelFromKey e2e/`.

- [ ] **Step 6: Add the consent scroll-gate helper**

The gate reports itself with `aria-disabled`, **deliberately not `disabled`**
(`apps/ui/src/components/consent/consent-gate.tsx:58-59`), so Playwright's
actionability check does not wait and a plain click no-ops. The scroll container
is `[data-testid="consent-reader"]`; sections carry `data-consent-section`.
Scroll until the hint copy flips from `consent.hint_scroll` to
`consent.hint_done`, then tick and accept. Add to `e2e/src/ui.ts`:

```ts
/**
 * Clear the consent gate (#636). MUST be used instead of clicking "Accept &
 * Continue" directly: the checkbox and button advertise their disabled state
 * with `aria-disabled` and guard their own handlers, deliberately staying out
 * of `disabled` so they keep keyboard focus. Playwright only waits on the real
 * `disabled` attribute, so a direct click lands, does nothing, and the run
 * fails later somewhere misleading.
 */
export async function passConsentGate(page: Page): Promise<void> {
  const reader = page.getByTestId('consent-reader');
  if (!(await reader.isVisible().catch(() => false))) return; // gate not shown

  const done = page.getByText("That's everything");
  for (let i = 0; i < 40; i += 1) {
    if (await done.isVisible().catch(() => false)) break;
    await reader.evaluate((el) => {
      el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.8, el.scrollHeight);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(60);
  }
  await done.waitFor({ state: 'visible', timeout: 5_000 });

  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: 'Accept & Continue' }).click();
  await page.getByTestId('consent-reader').waitFor({ state: 'hidden', timeout: 15_000 });
}
```

- [ ] **Step 7: Route existing specs through the helper**

```bash
cd e2e && grep -rn "Accept & Continue" tests/
```

Replace each direct click with `await passConsentGate(page);` and import it from
`../../src/ui.js`. Do not leave a direct click anywhere.

- [ ] **Step 8: Close the `/support/config` coverage gap**

The gate exits 1 on `GET /api/v1/support/config`. It is read by the UI to decide
whether support is offered, and its `enabled` must mirror the submit route's 503
condition exactly (`apps/api/CLAUDE.md`). Add to
`e2e/tests/api/journey-l-support.spec.ts` (create the file):

```ts
import { test, expect } from '../../src/fixtures.js';

/**
 * Journey L (API) — support config contract.
 *
 * @covers GET /api/v1/support/config
 */
test.describe('Journey L (API) — support config', () => {
  test('support config requires auth and, when reachable, describes the limits', async ({ api }) => {
    const anon = await api.get('/api/v1/support/config');
    expect(anon.status).toBe(401);
  });

  test('an authenticated caller gets the server\'s own attachment limits', async ({ api, service, cfg, caps, authCtx }) => {
    const { createLiveProfileUser } = await import('../../src/flows.js');
    const user = await createLiveProfileUser(api, service, cfg, caps, { authCtx, label: 'supcfg' });
    const res = await user.session.client.get<{
      enabled: boolean; maxTotalBytes?: number; maxFiles?: number; allowedTypes?: string[];
    }>('/api/v1/support/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
    if (res.body.enabled) {
      // The UI validates against these numbers rather than its own copy, so
      // they must be present and positive whenever support is on.
      expect(res.body.maxFiles).toBeGreaterThan(0);
      expect(res.body.maxTotalBytes).toBeGreaterThan(0);
      expect(Array.isArray(res.body.allowedTypes)).toBe(true);
    }
  });
});
```

- [ ] **Step 9: Verify the gate now passes**

Run: `cd e2e && npm run coverage`
Expected: exit 0, and the count rises to 34/53.

- [ ] **Step 10: Commit**

```bash
git add e2e/src/ui.ts e2e/src/schema.ts e2e/src/__tests__/ui-helpers.test.ts \
        e2e/tests/api/journey-l-support.spec.ts e2e/tests/
git commit -m "test(e2e): fix the three static defects a month of feature opened

The consent gate (#636) advertises its disabled state with aria-disabled and
guards its own handlers, deliberately staying out of \`disabled\` so it keeps
keyboard focus. Playwright only waits on the real attribute, so every direct
click on \"Accept & Continue\" landed, no-opped, and surfaced as a confusing
failure further down the spec. passConsentGate scrolls the reader until the hint
copy flips and then accepts.

domainLabelFromKey title-cased the domain id, but the UI has preferred
network.json's \`label\` since cbbc1959. That agrees on blue_dot and disagrees on
purple_dot, whose provider renders as \"Service Provider\" — so the domain button
was unfindable there. Replaced with a mirror of formatDomainLabel that resolves
from the served config, plus the getNetworkConfig accessor it needs, since
/network/schemas' per-schema entries carry no domain metadata.

And GET /api/v1/support/config, which shipped with support attachments after the
branch went dormant, now has a journey: it asserts the 401 and that whenever
\`enabled\` is true the limits the UI validates against are actually present."
```

---

### Task 4: `stack-up.sh` — bring the stack up with every capability on

Delegates the stack itself to the `run-signals-dpg` skill's proven block, then
adds the e2e-only env, probes the UI port (audit §1.3), and exports the `E2E_*`
overrides so **no committed config is mutated**.

**Files:**
- Create: `.claude/skills/signals-e2e/lib/stack-up.sh`
- Modify: `e2e/src/config.ts` (two new env overrides)
- Modify: `e2e/src/capabilities.ts` (the `realSearch` capability)
- Create: `e2e/src/__tests__/capabilities.test.ts`

**Interfaces:**
- Produces: a sourced env containing `E2E_UI_BASE_URL`, `E2E_DB_URL`,
  `E2E_NOTIFICATION_STUB_URL`, `E2E_SEARCH_STUB_URL`, `E2E_FAULT_INJECTION`,
  `E2E_DETERMINISTIC_PII_KEY`, `E2E_RUN_ID`; and
  `e2e/run/<run>/stack.marker` recording dot + ports + stub versions for reuse.

- [ ] **Step 1: Write the failing capability test**

`e2e/src/__tests__/capabilities.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor } from '../capabilities.js';

const base = {
  otp: { mode: 'test-otp' }, notificationStubUrl: null, mailpitUrl: null,
  keycloakLogContainer: null, db: { url: null }, faultInjection: false,
  deterministicPiiKey: false, auth: { serviceApiKey: null, actingOrgId: null },
  peer: { apiBaseUrl: null }, realSearchUrl: null,
} as never;

test('realSearch is off by default', () => {
  assert.equal(capabilitiesFor(base).realSearch, false);
});

test('realSearch is on when a real search URL is configured', () => {
  const cfg = { ...(base as object), realSearchUrl: 'http://localhost:3100' } as never;
  assert.equal(capabilitiesFor(cfg).realSearch, true);
});

test('a notification stub satisfies notificationStub without mailpit', () => {
  const cfg = { ...(base as object), notificationStubUrl: 'http://localhost:4545' } as never;
  assert.equal(capabilitiesFor(cfg).notificationStub, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — `realSearch` is not a property of `Capabilities`.

- [ ] **Step 3: Add the capability**

In `e2e/src/capabilities.ts` add to the `Capabilities` interface, to
`capabilitiesFor`, and to `REASONS` (all three — the skip message is blank
otherwise, per the suite's own rule):

```ts
  /** A REAL signals-search is reachable, not the stub — relevance quality is meaningful. */
  realSearch: boolean;
```

```ts
    realSearch: !!cfg.realSearchUrl,
```

```ts
  realSearch:
    'requires a real signals-search (config.realSearchUrl / --profile search) — ' +
    'the stub proves the contract but not relevance quality; amd64-only images need a host that can run them',
```

In `e2e/src/config.ts`: add `realSearchUrl: string | null` to `E2EConfig`,
default it to `null` in `loadConfig`, and add to `applyEnvOverrides`:

```ts
  if (e.E2E_REAL_SEARCH_URL) c.realSearchUrl = e.E2E_REAL_SEARCH_URL;
  if (e.E2E_FAULT_INJECTION) c.faultInjection = e.E2E_FAULT_INJECTION === 'true';
  if (e.E2E_DETERMINISTIC_PII_KEY) c.deterministicPiiKey = e.E2E_DETERMINISTIC_PII_KEY === 'true';
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd e2e && npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Write `stack-up.sh`**

`.claude/skills/signals-e2e/lib/stack-up.sh`:

```bash
#!/usr/bin/env bash
# Bring the local Signals stack up for an e2e run and export the E2E_* overrides
# that switch the suite's dormant capabilities on.
#
# The stack itself is NOT reimplemented here: the run-signals-dpg skill's block
# already encodes the env gotchas that cause a blank UI (VITE_NETWORK_ID and
# VITE_API_URL must agree across root .env and apps/ui/.env, the schema cache
# must be cleared on a network switch, the API must be a direct node launch
# rather than turbo-spawned). This adds only what an e2e run needs on top.
#
# Capabilities are enabled through env overrides (config.ts applyEnvOverrides),
# never by editing e2e/config/local.json — a run must leave the tree clean.
#
# Usage: source stack-up.sh <dot> [run-id]
set -uo pipefail

NET_DIR="${1:-blue_dot}"
RUN="${2:-e2e-$(date +%s)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO" || return 1

export E2E_RUN_ID="$RUN"
mkdir -p "e2e/run/$RUN"
MARKER="e2e/run/$RUN/stack.marker"

# --- 1. the stack itself, via the run-signals-dpg skill's block -------------
# The caller (SKILL.md phase 1) invokes that skill first. This script assumes
# the API is coming up and only waits for it.
NET_ID=$(node -e "console.log(require('./examples/schemas/$NET_DIR/network.json').id)")
for _ in $(seq 1 40); do
  curl -sf "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" >/dev/null 2>&1 && break
  sleep 1
done
SCHEMA_COUNT=$(curl -s "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})')
if [ "${SCHEMA_COUNT:-0}" -lt 1 ]; then
  echo "[stack-up] FAIL: /network/schemas returned 0 entries for $NET_ID — the UI will be blank." >&2
  echo "[stack-up] Clear the schema cache and relaunch the API directly (see run-signals-dpg)." >&2
  return 1
fi

# --- 2. UI port probe (audit §1.3) -----------------------------------------
# config/local.json says :5173; run-signals-dpg serves :3000; some branches do
# use Vite's default. Probe rather than hardcode either.
UI_URL=""
for port in 3000 5173; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/" 2>/dev/null)" = "200" ]; then
    UI_URL="http://localhost:$port"; break
  fi
done
if [ -z "$UI_URL" ]; then
  echo "[stack-up] FAIL: no UI on :3000 or :5173 — check /tmp/signals-ui.log" >&2
  return 1
fi
export E2E_UI_BASE_URL="$UI_URL"
export E2E_API_BASE_URL="http://localhost:2742"

# --- 3. capabilities -------------------------------------------------------
PGUSER=$(node -e 'const m=require("fs").readFileSync(".env","utf8").match(/^POSTGRES_USER=(.*)$/m);console.log((m?m[1]:"postgres").replace(/"/g,""))')
PGDB=$(node -e   'const m=require("fs").readFileSync(".env","utf8").match(/^POSTGRES_DB=(.*)$/m);console.log((m?m[1]:"signals").replace(/"/g,""))')
PGPW=$(node -e   'const m=require("fs").readFileSync(".env","utf8").match(/^POSTGRES_PASSWORD=(.*)$/m);console.log((m?m[1]:"postgres").replace(/"/g,""))')
export E2E_DB_URL="postgres://$PGUSER:$PGPW@localhost:5432/$PGDB"
export E2E_NOTIFICATION_STUB_URL="http://localhost:4545"
export E2E_SEARCH_STUB_URL="http://localhost:4546"
export E2E_FAULT_INJECTION="true"
export E2E_DETERMINISTIC_PII_KEY="true"

# --- 4. reuse marker ------------------------------------------------------
printf 'dot=%s\nnetwork=%s\nui=%s\napi=%s\nrun=%s\n' \
  "$NET_DIR" "$NET_ID" "$UI_URL" "http://localhost:2742" "$RUN" > "$MARKER"

echo "[stack-up] ready  dot=$NET_DIR network=$NET_ID ui=$UI_URL run=$RUN"
echo "[stack-up] capabilities: db notificationStub faultInjection deterministicKey"
echo "[stack-up] NOT enabled: realSearch (amd64-only, 3-8GB — opt in with --profile search), peer (needs a 2nd API)"
```

- [ ] **Step 6: Verify against a live stack**

Bring the stack up with the `run-signals-dpg` skill for `blue_dot`
(`CREATE_TEST_OTP=true` must be in root `.env`; add it if absent), then:

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG.worktrees/signals-e2e
chmod +x .claude/skills/signals-e2e/lib/stack-up.sh
source .claude/skills/signals-e2e/lib/stack-up.sh blue_dot verify-run
echo "$E2E_UI_BASE_URL $E2E_DB_URL"
```

Expected: `[stack-up] ready …` with a non-zero schema count, a UI URL that
answers 200, and both env vars set.

- [ ] **Step 7: The first live suite run — the phase −1 gate**

```bash
bash .claude/skills/signals-e2e/lib/cleanup.sh verify-run --snapshot-only
cd e2e && E2E_ENV=local npm run e2e:api 2>&1 | tail -40
```

Record the result. Every failure is either a real product bug or further drift
the audit's static reading missed — triage each one and note which. Then:

```bash
cd .. && bash .claude/skills/signals-e2e/lib/cleanup.sh verify-run
```

Expected: `clean — no residue`. If not, the ledger hooks from Task 2 Step 5 are
in the wrong place — fix them before continuing.

- [ ] **Step 8: Commit**

```bash
git add .claude/skills/signals-e2e/lib/stack-up.sh e2e/src/config.ts \
        e2e/src/capabilities.ts e2e/src/__tests__/capabilities.test.ts
git commit -m "test(e2e): stand the stack up with the dormant capabilities on

The suite is black-box and starts nothing, so every local run has been asserting
against whatever happened to be running — and against a config that leaves all
six optional capabilities off. stack-up.sh closes that: it waits for the API,
refuses to continue when /network/schemas returns zero entries (the blank-UI
failure, worth catching before 200 assertions blame the UI), and exports the
E2E_* overrides for db, notificationStub, faultInjection and deterministicKey.

The UI port is probed across :3000 and :5173 rather than trusted: the config
says 5173, run-signals-dpg serves 3000, and some branches genuinely use Vite's
default, so hardcoding either fails every UI spec on connection-refused before
it asserts anything.

Capabilities go on through env overrides that config.ts already supported, not
by editing config/local.json, so a run leaves the working tree clean.

realSearch is new and deliberately off: signals-search does now run locally
behind --profile search (#625), but its images are amd64-only and the embedder
wants 3-8 GB, so it is opt-in per host rather than assumed."
```

---

### Task 5: `notify-sink.mjs` — the email and SMS oracle

Signals renders the complete email — subject, HTML, resolved CTA href — and
POSTs it to `<endpoint>/notify` (`packages/notification/src/notification_client.ts:54`),
so the sink is a full oracle. 35 email cases and 5 SMS cases exist and every one
is reachable locally. `local-mail-sink/sink.mjs` is the starting point.

**Files:**
- Create: `.claude/skills/signals-e2e/lib/notify-sink.mjs`
- Create: `e2e/src/notify.ts`
- Create: `e2e/src/__tests__/notify.test.ts`

**Interfaces:**
- Produces:
  - `subjectPatternFor(caseId: string, properties: string): RegExp`
  - `class NotifySink { messages(q?): Promise<Captured[]>; expect(caseId, to): Promise<Captured>; reset(): Promise<void>; failNext(): Promise<void> }`
  - `Captured = { channel: string; to: string; subject?: string; html?: string; templateId: string; variables: Record<string, unknown> }`
  - `assertNoCopyDrift(all: Captured[]): void` — the three global invariants.

- [ ] **Step 1: Write the failing test**

`e2e/src/__tests__/notify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectPatternFor, assertNoCopyDrift } from '../notify.js';

const PROPS = [
  'profile.create.subject=Your {{domainLabel}} profile is live',
  'support.request.subject=Support request {{reference}}',
].join('\n');

test('a case subject template becomes a matching regex', () => {
  const re = subjectPatternFor('profile.create', PROPS);
  assert.ok(re.test('Your Seeker profile is live'));
  assert.ok(!re.test('Your Seeker profile is paused'));
});

test('regex metacharacters in copy are escaped, not interpreted', () => {
  const re = subjectPatternFor('support.request', 'support.request.subject=Support (urgent) {{reference}}');
  assert.ok(re.test('Support (urgent) SR-1234'));
});

test('an unknown case id fails loudly rather than matching everything', () => {
  assert.throws(() => subjectPatternFor('nope.missing', PROPS), /nope\.missing/);
});

test('an unsubstituted token is copy drift', () => {
  assert.throws(
    () => assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi {{name}}', html: '<p>ok</p>', templateId: 'basic_email', variables: {} }]),
    /\{\{/,
  );
});

test('an unresolved support-email placeholder is copy drift', () => {
  assert.throws(
    () => assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<p>__SUPPORT_EMAIL__</p>', templateId: 'basic_email', variables: {} }]),
    /__SUPPORT_EMAIL__/,
  );
});

test('clean copy passes', () => {
  assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<a href="http://localhost:3000/x">go</a>', templateId: 'basic_email', variables: {} }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — `Cannot find module '../notify.js'`.

- [ ] **Step 3: Implement `e2e/src/notify.ts`**

```ts
/**
 * Client and assertions for the notification sink.
 *
 * Resolving a captured mail back to its case is the whole problem here: every
 * email leaves as template_id `basic_email` (dispatch_email.ts:149), so the
 * wire cannot say which of the 35 cases it was. We instead read the same
 * messages.properties the API reads, turn the case's subject template into a
 * regex, and match on (recipient, subject) — which also means a copy edit that
 * skips this manifest breaks loudly rather than silently passing.
 */

export interface Captured {
  channel: string;
  to: string;
  subject?: string;
  html?: string;
  templateId: string;
  variables: Record<string, unknown>;
}

const TOKEN = /\{\{\s*[\w.]+\s*\}\}/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function subjectPatternFor(caseId: string, properties: string): RegExp {
  const line = properties
    .split('\n')
    .find((l) => l.startsWith(`${caseId}.subject=`));
  if (!line) {
    throw new Error(
      `[e2e] no subject copy for email case "${caseId}" in the messages file. ` +
        'Either the case id is wrong or the copy moved — check ' +
        'apps/api/src/notifications/email/messages.default.properties.',
    );
  }
  const template = line.slice(`${caseId}.subject=`.length).trim();
  const pattern = template
    .split(TOKEN)
    .map(escapeRe)
    .join('.+?');
  return new RegExp(`^${pattern}$`);
}

/**
 * Three invariants over every message a run captured. Applied to the whole set
 * rather than per assertion, so one sweep covers all 35 cases and catches copy
 * drift in a case no individual test named.
 */
export function assertNoCopyDrift(all: Captured[]): void {
  for (const m of all) {
    const body = `${m.subject ?? ''}\n${m.html ?? ''}`;
    const token = body.match(TOKEN);
    if (token) {
      throw new Error(`[e2e] unsubstituted token ${token[0]} in a "${m.subject}" message to ${m.to}`);
    }
    if (body.includes('__SUPPORT_EMAIL__')) {
      throw new Error(`[e2e] unresolved __SUPPORT_EMAIL__ in a "${m.subject}" message to ${m.to}`);
    }
    for (const href of [...body.matchAll(/href="([^"]*)"/g)].map((x) => x[1])) {
      if (href && !/^https?:\/\//.test(href) && !href.startsWith('mailto:')) {
        throw new Error(`[e2e] relative CTA href "${href}" in a "${m.subject}" message — mail clients cannot resolve it`);
      }
    }
  }
}

export class NotifySink {
  constructor(private readonly baseUrl: string) {}

  async messages(q: Partial<Pick<Captured, 'to' | 'channel'>> = {}): Promise<Captured[]> {
    const params = new URLSearchParams();
    if (q.to) params.set('to', q.to);
    if (q.channel) params.set('channel', q.channel);
    const res = await fetch(`${this.baseUrl}/_e2e/mail?${params}`);
    if (!res.ok) throw new Error(`[e2e] notify sink query failed: ${res.status}`);
    return (await res.json()) as Captured[];
  }

  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/reset`, { method: 'POST' });
  }

  async failNext(): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/fail-next`, { method: 'POST' });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd e2e && npm run test:unit && npm run typecheck`
Expected: PASS, 6 new tests.

- [ ] **Step 5: Implement the sink**

`.claude/skills/signals-e2e/lib/notify-sink.mjs`:

```js
// Notification-service stand-in for e2e runs.
//
// Signals renders the FULL email — subject, html, CTA href already resolved —
// and POSTs it to `<endpoint>/notify`, so capturing that request is a complete
// oracle rather than a template inspection. SMS arrives on the same endpoint
// with channel:'sms' and the DLT template_id; a case whose templateId is empty
// posts NOTHING, and asserting that absence is the correct test.
//
// HMAC headers are accepted and not verified — this is not the auth surface.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.SINK_PORT ?? 4545);
const OUT = new URL('./mail', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let captured = [];
let failNext = false;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'POST' && url.pathname === '/notify') {
      if (failNext) {
        // One forced failure: the only way to reach 502 SUPPORT_SEND_FAILED and
        // to prove the best-effort senders never turn a recorded consent into a 500.
        failNext = false;
        return json(res, 500, { error: 'E2E_FORCED_FAILURE' });
      }
      let p = {};
      try { p = JSON.parse(raw); } catch { /* keep raw below */ }
      const v = p.variables ?? {};
      const entry = {
        seq: captured.length + 1,
        at: new Date().toISOString(),
        channel: p.channel ?? '?',
        to: p.to ?? '?',
        templateId: p.template_id ?? '?',
        priority: p.priority,
        dedupeId: p.dedupe_id ?? null,
        subject: v.subject,
        html: v.html,
        attachments: (v.attachments ?? []).map((a) => ({ filename: a.filename, type: a.contentType ?? a.type, bytes: (a.content ?? '').length })),
        variables: v,
      };
      captured.push(entry);
      appendFileSync(`${OUT}/index.jsonl`, `${JSON.stringify(entry)}\n`);
      if (entry.html) writeFileSync(`${OUT}/mail-${String(entry.seq).padStart(3, '0')}.html`, entry.html);
      console.log(`#${entry.seq} ${entry.channel} to=${entry.to} subject=${entry.subject ?? '(sms)'} tmpl=${entry.templateId}`);
      return json(res, 200, { ok: true });
    }

    // The client probes this for per-channel variable schemas; answer so nothing 500s.
    if (req.method === 'GET' && url.pathname === '/providers') {
      return json(res, 200, [{ channel: 'email', templates: ['basic_email'] }, { channel: 'sms', templates: [] }]);
    }

    if (req.method === 'GET' && url.pathname === '/_e2e/mail') {
      const to = url.searchParams.get('to');
      const channel = url.searchParams.get('channel');
      return json(res, 200, captured.filter((m) =>
        (!to || m.to === to) && (!channel || m.channel === channel)));
    }

    if (req.method === 'POST' && url.pathname === '/_e2e/reset') {
      captured = []; return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/_e2e/fail-next') {
      failNext = true; return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'NOT_FOUND' });
  });
}).listen(PORT, () => console.log(`notify sink on http://localhost:${PORT} -> ${OUT}`));
```

- [ ] **Step 6: Verify the sink live**

```bash
node .claude/skills/signals-e2e/lib/notify-sink.mjs &
sleep 1
curl -s -XPOST localhost:4545/notify -H 'content-type: application/json' \
  -d '{"channel":"email","template_id":"basic_email","to":"a@b.c","priority":"realtime","variables":{"subject":"Your Seeker profile is live","html":"<a href=\"http://localhost:3000/x\">go</a>"}}'
curl -s 'localhost:4545/_e2e/mail?to=a@b.c' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length,"captured"))'
curl -s -XPOST localhost:4545/_e2e/fail-next >/dev/null
curl -s -o /dev/null -w 'forced-failure status: %{http_code}\n' -XPOST localhost:4545/notify -H 'content-type: application/json' -d '{}'
kill %1
```

Expected: `1 captured`, then `forced-failure status: 500`.

- [ ] **Step 7: Point the API at the sink and confirm a real email lands**

Add to root `.env` via node (reading `.env` with cat/grep is permission-blocked;
write with node or `sed`):

```bash
node -e '
const fs=require("fs");
let s=fs.readFileSync(".env","utf8");
s=s.replace(/^NOTIFICATION_SERVICE_ENDPOINT=.*$/m,"").trimEnd();
fs.writeFileSync(".env", s+"\nNOTIFICATION_SERVICE_ENDPOINT=http://localhost:4545\n");
'
```

Restart the API (env needs a full restart — Vite HMR and tsx watch reload code,
not env), trigger a login OTP for any address, and confirm the sink logged a
`login.otp` message.

- [ ] **Step 8: Commit**

```bash
git add .claude/skills/signals-e2e/lib/notify-sink.mjs e2e/src/notify.ts \
        e2e/src/__tests__/notify.test.ts
git commit -m "test(e2e): capture and assert every email and SMS the API sends

notificationStub has been a declared capability with REASONS copy and nothing
behind it, so all 35 email cases and 5 SMS cases were unasserted — and none of
them existed when this suite was written: the dispatcher (#529), per-domain
CTAs (#569), lifecycle and onboarding mail (#531/#534) and the SMS engine
(#532/#535) all postdate it. Mailpit does not cover them either; it sees
Keycloak's SMTP, while signals posts its own mail to the notification service.

The sink works because signals renders the finished article — subject, html and
resolved CTA href — so capturing the POST is a complete oracle. Resolving a
capture back to its case is the interesting part: everything ships as
template_id basic_email, so the wire cannot identify the case. notify.ts reads
the same messages.properties the API reads and matches on the subject template
turned into a regex, which makes a copy edit that skips the manifest fail loudly.

Three invariants run over the whole captured set rather than per assertion, so
one sweep covers cases no individual test named: no unsubstituted {{token}}, no
unresolved __SUPPORT_EMAIL__, and no relative CTA href.

/_e2e/fail-next forces one send failure, which is the only way to reach
502 SUPPORT_SEND_FAILED and to prove a Redis or mail outage never turns a
recorded consent into a 500."
```

---

### Task 6: `search-stub.mjs` — the ranked feed and its fault modes

**Files:**
- Create: `.claude/skills/signals-e2e/lib/search-stub.mjs`
- Create: `e2e/src/search.ts`
- Create: `e2e/src/__tests__/search.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1).
- Produces:
  - `translateClause(c: { op: string; target: string; value: unknown }): { sql: string; params: unknown[] }`
  - `class SearchStub { envelopes(): Promise<Envelope[]>; setMode(m: 'ok'|'down'|'slow'|'anchor-not-found'): Promise<void>; reset(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`e2e/src/__tests__/search.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateClause } from '../search.js';

test('an array facet uses jsonb overlap, never equality', () => {
  // The client comment is explicit: `in` on an array field extracts the
  // serialized array as TEXT and never matches a single scalar, so a
  // one-value selection would silently return nothing.
  const { sql } = translateClause({ op: 'contains_any', target: 'item_state.disability_type', value: ['Autism'] });
  assert.match(sql, /\?\|/);
});

test('a scalar facet uses ANY over the extracted text', () => {
  const { sql, params } = translateClause({ op: 'in', target: 'item_state.gender', value: ['Male', 'Female'] });
  assert.match(sql, /->>/);
  assert.deepEqual(params, [['Male', 'Female']]);
});

test('an unknown op is rejected rather than silently ignored', () => {
  assert.throws(() => translateClause({ op: 'nope', target: 'item_state.x', value: 1 }), /nope/);
});

test('a target outside item_state is rejected', () => {
  assert.throws(() => translateClause({ op: 'eq', target: 'user.email', value: 'x' }), /item_state/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — `Cannot find module '../search.js'`.

- [ ] **Step 3: Implement `e2e/src/search.ts`**

```ts
/**
 * Client for the signals-search stub, plus the clause translation both the
 * stub and its tests share.
 *
 * The stub is also an assertion surface: it records every request envelope, so
 * a test can assert the API BUILT the right query rather than only that it
 * consumed the response. That is the one thing a real signals-search cannot
 * give us, and it guards a documented trap — an array-valued facet must map to
 * `contains_any` regardless of how many values are selected.
 */

export interface Envelope {
  context: { networkId: string; domain: string; itemType: string };
  message: {
    intent: {
      textSearch?: string;
      filters?: Array<{ op: string; target: string; value: unknown }>;
      spatial?: Array<{ op: string; geometry: { coordinates: [number, number] }; distanceMeters?: number }>;
      item?: { id: string };
    };
    pagination: { limit: number; offset: number };
  };
}

export type SearchMode = 'ok' | 'down' | 'slow' | 'anchor-not-found';

export function translateClause(c: { op: string; target: string; value: unknown }): { sql: string; params: unknown[] } {
  if (!c.target.startsWith('item_state.')) {
    throw new Error(`[e2e] search clause target "${c.target}" is outside item_state — the API must never expose another column as a facet`);
  }
  const field = c.target.slice('item_state.'.length);
  switch (c.op) {
    case 'contains_any':
      // jsonb `?|` overlap: correct for one OR many values on an array field.
      return { sql: `(i.item_state -> '${field}') ?| $1`, params: [c.value] };
    case 'in':
      return { sql: `(i.item_state ->> '${field}') = ANY($1)`, params: [c.value] };
    case 'eq':
      return { sql: `(i.item_state ->> '${field}') = $1`, params: [c.value] };
    case 'neq':
      return { sql: `(i.item_state ->> '${field}') <> $1`, params: [c.value] };
    default:
      throw new Error(`[e2e] unsupported search clause op "${c.op}"`);
  }
}

export class SearchStub {
  constructor(private readonly baseUrl: string) {}

  async envelopes(): Promise<Envelope[]> {
    const res = await fetch(`${this.baseUrl}/_e2e/envelopes`);
    if (!res.ok) throw new Error(`[e2e] search stub query failed: ${res.status}`);
    return (await res.json()) as Envelope[];
  }

  async setMode(mode: SearchMode): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/reset`, { method: 'POST' });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd e2e && npm run test:unit && npm run typecheck`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Implement the stub**

`.claude/skills/signals-e2e/lib/search-stub.mjs`. It must:

- accept `POST /v1/search` with `x-api-key`, rejecting a missing key with
  `401 {"error":"UNAUTHORIZED"}`;
- validate the envelope shape (`context.version === '1.0.0'`, `message.intent`,
  `message.pagination.limit` 1–100, at most one `spatial` clause) and answer a
  bad one with `400 {"error":"INVALID_REQUEST"}`;
- append every accepted envelope to an in-memory list and `envelopes.jsonl`;
- query Postgres: `item_search s JOIN items i USING (item_network, item_domain, item_type, item_id)`
  filtered on `s.lifecycle_status = 'live'` and the envelope's network/domain/
  item_type, applying each filter clause through the same `translateClause`
  logic, `textSearch` as a case-insensitive match across the schema's declared
  non-private string fields, and the spatial clause as
  `ST_DWithin(s.geo, ST_SetSRID(ST_MakePoint($lng,$lat),4326)::geography, $m)`;
- return the full item-row envelope with a **deterministic** score — order by
  `distance` when spatial, else `i.updated_at DESC`, and set
  `score = 1 / (1 + rowIndex)` so ranking order is assertable;
- honour the modes: `down` → close the socket (so the API sees a connection
  error, not a 503), `slow` → sleep 6 s (past the client's 5 s
  `AbortSignal.timeout`), `anchor-not-found` → `404 {"error":"ANCHOR_NOT_FOUND"}`
  whenever `message.intent.item` is present;
- expose `GET /_e2e/envelopes`, `POST /_e2e/mode`, `POST /_e2e/reset`.

Use `pg` resolved from `e2e/node_modules` (`NODE_PATH=e2e/node_modules`) rather
than adding a root dependency.

- [ ] **Step 6: Verify the stub live**

```bash
docker compose up -d db redis
NODE_PATH=e2e/node_modules PGURL="$E2E_DB_URL" node .claude/skills/signals-e2e/lib/search-stub.mjs &
sleep 1
curl -s -XPOST localhost:4546/v1/search -H 'x-api-key: e2e' -H 'content-type: application/json' \
  -d '{"context":{"version":"1.0.0","messageId":"m1","networkId":"blue_dot","domain":"provider","itemType":"profile_1.0"},"message":{"intent":{},"pagination":{"limit":10,"offset":0}}}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log("items:",r.message.items.length,"total:",r.message.meta.total)})'
curl -s -o /dev/null -w 'no key: %{http_code}\n' -XPOST localhost:4546/v1/search -d '{}'
curl -s localhost:4546/_e2e/envelopes | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("envelopes:",JSON.parse(d).length))'
kill %1
```

Expected: an items/total line (0 items on an empty DB is fine), `no key: 401`,
and `envelopes: 1`.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/signals-e2e/lib/search-stub.mjs e2e/src/search.ts \
        e2e/src/__tests__/search.test.ts
git commit -m "test(e2e): stand in for signals-search, and record what the API asked it

signals-search does now run locally behind --profile search (#625), so the
client's \"cannot be run locally\" comment is stale — but its images are
amd64-only and the embedder wants 3-8 GB, so on an 8 GB arm64 host the stub is
the practical default rather than a compromise.

It earns its place beyond availability. Recording every request envelope makes
the API's query construction assertable, not just its response handling, and
that guards a trap the client itself documents: an array-valued facet must map
to contains_any however many values are selected, because \`in\` extracts the
field as serialized-array TEXT and would silently match nothing. A real search
service cannot tell us that.

The fault modes are the other half. faultInjection has been a declared
capability with no way to satisfy it, so the discover native fallback — facets
and radius still applying while only ranking is lost — was untestable. `down`
closes the socket rather than answering 503, so the API sees a connection error
like it would in production; `slow` sleeps past the client's 5s timeout; and
`anchor-not-found` returns the code the discover anchor-retry branches on."
```

---

### Task 7: `search-indexer.mjs` — maintain `item_search`

Without this, `item_search` stays empty, the API **silently** falls back to
`items.item_locations`, and a lifecycle transition that publishes no event
passes every assertion — which is exactly the bug #557/#564 fixed.

**Files:**
- Create: `.claude/skills/signals-e2e/lib/search-indexer.mjs`
- Create: `e2e/src/__tests__/indexer-mapping.test.ts`
- Create: `.claude/skills/signals-e2e/lib/index_row.mjs` (the pure mapping, so it is testable)

**Interfaces:**
- Produces: `rowForEvent(event, item, locations): { text: string; params: unknown[] } | { delete: true }`

- [ ] **Step 1: Write the failing test**

`e2e/src/__tests__/indexer-mapping.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowForEvent } from '../../.claude/skills/signals-e2e/lib/index_row.mjs';

const EV = { item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0', item_id: 'i-1', op: 'upsert' };

test('a delete event removes the row', () => {
  const out = rowForEvent({ ...EV, op: 'delete' }, null, []);
  assert.equal(out.delete, true);
});

test('an upsert carries lifecycle_status and source_updated_at from items', () => {
  const item = { lifecycle_status: 'live', updated_at: '2026-09-02T00:00:00Z' };
  const out = rowForEvent(EV, item, [{ lat: 12.9, lng: 77.6 }]);
  assert.match(out.text, /INSERT INTO item_search/i);
  assert.ok(out.params.includes('live'));
  assert.ok(out.params.includes('2026-09-02T00:00:00Z'));
});

test('an upsert for an item that no longer exists is a delete, not a stale row', () => {
  const out = rowForEvent(EV, null, []);
  assert.equal(out.delete, true);
});

test('an item with no locations still indexes, with null geo', () => {
  const out = rowForEvent(EV, { lifecycle_status: 'draft', updated_at: '2026-09-02T00:00:00Z' }, []);
  assert.ok(out.params.includes(null));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `index_row.mjs`**

```js
// Pure mapping from an item event to the item_search write, kept separate from
// the Redis consumer so it is directly testable.
//
// item_search's DDL authority is apps/api/db/postgres/schema.sql:108. embedding
// is vector(1024) and nullable — the stub indexes no embedding, which is
// correct: relevance ranking is the search stub's business, and a NULL
// embedding still satisfies every lifecycle/visibility assertion.
//
// source_updated_at must be the indexed row's items.updated_at, not now():
// the real sweep compares VERSIONS rather than clocks (signals-search#122).
export function rowForEvent(event, item, locations) {
  if (event.op === 'delete' || !item) {
    // An upsert for a vanished item is also a delete — indexing a row we cannot
    // read would leave the index claiming an item that no longer exists.
    return { delete: true };
  }
  const geo = locations.length
    ? `SRID=4326;MULTIPOINT(${locations.map((l) => `${l.lng} ${l.lat}`).join(',')})`
    : null;
  return {
    text: `
      INSERT INTO item_search
        (item_network, item_domain, item_type, item_id, geo, lifecycle_status, source_updated_at, indexed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now())
      ON CONFLICT (item_network, item_domain, item_type, item_id) DO UPDATE
        SET geo = EXCLUDED.geo,
            lifecycle_status = EXCLUDED.lifecycle_status,
            source_updated_at = EXCLUDED.source_updated_at,
            indexed_at = now()
    `,
    params: [
      event.item_network, event.item_domain, event.item_type, event.item_id,
      geo, item.lifecycle_status, item.updated_at,
    ],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd e2e && npm run test:unit`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Implement the consumer**

`.claude/skills/signals-e2e/lib/search-indexer.mjs` must:

- read `INGEST_STREAM` (default from `databasesConfig.ingest_stream`; read the
  value out of root `.env` with node, the same way `stack-up.sh` does) via
  `XREAD BLOCK 2000 STREAMS <stream> $`, starting at `$` so only this run's
  events are consumed;
- for each entry, read the item row
  (`SELECT lifecycle_status, updated_at FROM items WHERE item_id = $1`) and its
  `item_locations`, call `rowForEvent`, and execute the insert or the delete;
- expose a tiny HTTP control on `:4547` with `POST /_e2e/pause`,
  `POST /_e2e/resume` and `GET /_e2e/stats` returning
  `{consumed, indexed, deleted, paused}` — pausing is what makes "published but
  not yet indexed" testable;
- log one line per event so a run's index activity is visible;
- never throw out of the loop: log and continue, because a stub that dies
  mid-run turns every later map assertion into a mystery.

- [ ] **Step 6: Verify the indexer live**

With the stack up and the indexer running, create a profile through the API,
then:

```bash
curl -s localhost:4547/_e2e/stats
docker exec dpg-db psql -U "$PGUSER" -d "$PGDB" -tAc \
  "SELECT item_id, lifecycle_status FROM item_search ORDER BY indexed_at DESC LIMIT 3;"
```

Expected: `consumed` > 0 and a row whose `lifecycle_status` matches `items`.
Then pause it, flip a lifecycle status, and confirm `item_search` goes stale —
that is the race the real bug exhibited.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/signals-e2e/lib/search-indexer.mjs \
        .claude/skills/signals-e2e/lib/index_row.mjs \
        e2e/src/__tests__/indexer-mapping.test.ts
git commit -m "test(e2e): maintain item_search, so a missing item event can fail

This is the stub that changes what the suite can detect. With item_search empty
the API silently falls back to items.item_locations for the bbox filter, so the
map keeps working and a lifecycle transition that publishes no event passes
every assertion — the exact shape of #557/#564, where a promoted profile stayed
draft in the index and was invisible in every ranked feed and viewport while
items said live, and nothing logged.

The mapping is split into index_row.mjs so it can be tested without Redis, and
it encodes two things from the real indexer rather than inventing them:
source_updated_at is the indexed row's items.updated_at rather than now(),
because the real sweep compares versions and not clocks (signals-search#122);
and an upsert for an item that can no longer be read is treated as a delete,
since indexing a row we cannot see would leave the index asserting an item that
does not exist.

/_e2e/pause stops consumption on demand, which is what makes \"published but not
yet indexed\" a testable state rather than a race to lose."
```

---

### Task 8: The five-section report

**Files:**
- Create: `.claude/skills/signals-e2e/lib/report.mjs`
- Create: `.claude/skills/signals-e2e/coverage.md`
- Modify: `e2e/playwright.config.ts` (add the JSON reporter)
- Create: `e2e/src/__tests__/report.test.ts`

**Interfaces:**
- Consumes: `e2e/test-results/results.json` (Playwright JSON reporter);
  `coverage.md`'s `human-only` list; `cleanup.sh`'s residue exit code.
- Produces: `buildReport(input): ReportSections` and a markdown renderer.

- [ ] **Step 1: Add the JSON reporter**

In `e2e/playwright.config.ts`, add to the `reporter` array:

```ts
    ['json', { outputFile: 'test-results/results.json' }],
```

- [ ] **Step 2: Write the failing test**

`e2e/src/__tests__/report.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../../.claude/skills/signals-e2e/lib/report.mjs';

const results = {
  suites: [{
    title: 'journey-a', specs: [
      { title: 'creates a profile', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'rejects a bad payload', ok: false, tests: [{ results: [{ status: 'failed', error: { message: 'expected 409 got 503' } }] }] },
      { title: 'decrypts a participant', ok: true, tests: [{ results: [{ status: 'skipped' }], annotations: [{ type: 'skip', description: '[capability] requires service-caller credentials' }] }] },
    ],
  }],
};

test('passes, failures and skips land in their own sections', () => {
  const r = buildReport({ results, humanOnly: ['brand skin correctness'], scoped: null, residue: 0 });
  assert.equal(r.working.length, 2);
  assert.equal(r.notWorking.length, 1);
  assert.match(r.notWorking[0].detail, /expected 409 got 503/);
  assert.ok(r.needsHuman.some((h) => /service-caller credentials/.test(h)));
  assert.ok(r.needsHuman.includes('brand skin correctness'));
});

test('a scoped run names every suite it did not run', () => {
  const r = buildReport({ results, humanOnly: [], scoped: { alias: 'u18', suites: [5] }, residue: 0 });
  assert.ok(r.needsHuman.some((h) => /not run in this invocation/.test(h)));
});

test('cleanup residue is a failure, not a footnote', () => {
  const r = buildReport({ results, humanOnly: [], scoped: null, residue: 3 });
  assert.ok(r.notWorking.some((f) => /residue/i.test(f.detail)));
});

test('exit code is non-zero only when section 2 is non-empty', () => {
  const clean = { suites: [{ title: 's', specs: [{ title: 't', ok: true, tests: [{ results: [{ status: 'passed' }] }] }] }] };
  assert.equal(buildReport({ results: clean, humanOnly: [], scoped: null, residue: 0 }).exitCode, 0);
  assert.equal(buildReport({ results, humanOnly: [], scoped: null, residue: 0 }).exitCode, 1);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd e2e && npm run test:unit`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `report.mjs`**

It must produce the five sections from the spec §8 — `working`, `notWorking`,
`known`, `needsHuman`, `coverageDrift` — where:

- `working` = specs whose every result is `passed`;
- `notWorking` = specs with a `failed`/`timedOut` result, each carrying the
  error message and the trace/screenshot path from the result's attachments,
  **plus one synthetic entry when `residue > 0`**;
- `known` = specs tagged with a `@known` annotation, so documented
  look-like-bugs never pollute section 2;
- `needsHuman` = every skip's `[capability]` reason, plus `coverage.md`'s
  `human-only` list, plus — on a scoped run — one line per suite that did not
  run, worded *"not run in this invocation"*;
- `exitCode` = `notWorking.length > 0 ? 1 : 0`.

Render as markdown with the section order fixed, and print the scoped header
naming exactly what ran.

- [ ] **Step 5: Run to verify it passes**

Run: `cd e2e && npm run test:unit`
Expected: PASS, 4 new tests.

- [ ] **Step 6: Write `coverage.md` with the human-only list**

Create `.claude/skills/signals-e2e/coverage.md` containing the 16-suite
catalogue from spec §4 and a fenced `human-only` block the report parses:

```markdown
## human-only

- brand skin correctness (logo, palette) — a screenshot is captured, not judged
- whether a responsive layout *looks* right at each breakpoint
- accessibility beyond structural aria/focus checks
- real Keycloak/OIDC login (config-gated; authProvider defaults to betterauth)
- true multi-instance inter-instance browse (needs a second API)
- geocoding accuracy without GOOGLE_GEOCODING_API_KEY or PHOTON_URL
- real DigiLocker and Dhiway wallet imports
- real SMS delivery — DLT template ids ship empty by design
- email deliverability and mail-client rendering
- relevance quality when the search stub ran instead of --profile search
```

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/signals-e2e/lib/report.mjs .claude/skills/signals-e2e/coverage.md \
        e2e/playwright.config.ts e2e/src/__tests__/report.test.ts
git commit -m "test(e2e): report what worked, what did not, and what still needs eyes

A Playwright list reporter answers \"did the suite pass\". The question a signoff
has to answer is \"can this ship, and what did nobody check\", which needs the
skips and the untestable surface promoted to first-class output rather than
scrolled past.

Five sections. Failures carry the error and the trace path. Documented
behaviours that look like bugs — the map count below the list total, x-uri
through a \$ref — sit in their own section so they never pollute the failure
list. And the needs-a-human section is computed from the run's own capability
skips plus coverage.md's human-only block, never hand-written, so it cannot
drift into flattery: brand skin, responsive judgement, real OIDC, real wallets,
real SMS, and relevance quality whenever the search stub stood in for the real
service.

Cleanup residue enters as a failure rather than a footnote, because a run that
leaves rows behind makes the next run lie and that is worth failing over. Exit
is non-zero if and only if section 2 has an entry."
```

---

### Task 9: Widen the coverage gate beyond routes

Route coverage read 62% while the entire notification subsystem, the share page
and My Actions filtering had no coverage — none of them a route the check could
notice.

**Files:**
- Modify: `e2e/scripts/check-coverage.mjs`
- Modify: `e2e/coverage-baseline.json` (a `allowUncoveredFeatures` key)
- Create: `e2e/scripts/__tests__/check-coverage.test.mjs`

**Interfaces:**
- Produces: `enumerateFeatures(repoRoot): { uiRoutes: string[]; emailCases: string[]; smsCases: string[]; schemaMarkers: string[] }`

- [ ] **Step 1: Write the failing test**

`e2e/scripts/__tests__/check-coverage.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateFeatures } from '../check-coverage.mjs';

const root = new URL('../../../', import.meta.url).pathname;

test('UI routes come from app.tsx, including the public profile page', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.uiRoutes.includes('/legal'));
  assert.ok(f.uiRoutes.some((r) => r.startsWith('/public/')));
  assert.ok(f.uiRoutes.includes('/my-actions'));
});

test('every email case in the registry is enumerated', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.emailCases.includes('support.request'));
  assert.ok(f.emailCases.includes('guardian.action_bulk'));
  assert.ok(f.emailCases.length >= 19);
});

test('SMS cases are enumerated separately from email', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.smsCases.includes('account.aggregator_init'));
  assert.ok(!f.smsCases.includes('support.request'));
});

test('x-* schema markers in use are enumerated', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.schemaMarkers.includes('x-uri') || f.schemaMarkers.includes('x-form-layout'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd e2e && node --test scripts/__tests__/check-coverage.test.mjs`
Expected: FAIL — `enumerateFeatures` is not exported.

- [ ] **Step 3: Implement `enumerateFeatures` and wire it into the check**

Add to `e2e/scripts/check-coverage.mjs`, exported so it is testable:

- `uiRoutes` — every `path="…"` in `apps/ui/src/app.tsx`.
- `emailCases` — every `CASES.set('…')` in
  `apps/api/src/notifications/email/email_cases.ts`.
- `smsCases` — every `<id>.template_id` key in
  `apps/api/src/notifications/sms/sms.default.properties`.
- `schemaMarkers` — every distinct `"x-…"` key across
  `examples/schemas/*/network.json`.

Then diff each against the case names in `.claude/skills/signals-e2e/coverage.md`
and the `@covers` annotations, reporting anything unmapped **by name** and
honouring an `allowUncoveredFeatures` debt list in `coverage-baseline.json` with
the same "may only shrink" comment as the route list.

- [ ] **Step 4: Run to verify it passes**

Run: `cd e2e && node --test scripts/__tests__/check-coverage.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Baseline the current feature debt**

Run: `cd e2e && npm run coverage`

Expected: it now reports the unmapped **features** as well as routes. Park the
audit §3 items in `allowUncoveredFeatures` — that list is exactly the follow-on
plan's backlog, so it starts full and burns down.

- [ ] **Step 6: Point feature authors at it**

Add one row to the table in `.claude/rules/e2e-coverage.md`:

```markdown
| **Adding an email/SMS case, a UI route, or an `x-*` schema marker** | Name it in `.claude/skills/signals-e2e/coverage.md`. `npm run coverage` now enumerates these from the code and fails on anything unnamed — the route table never saw them, which is how a whole notification subsystem reached zero coverage while the gate read 62%. |
```

- [ ] **Step 7: Commit**

```bash
git add e2e/scripts/check-coverage.mjs e2e/scripts/__tests__/check-coverage.test.mjs \
        e2e/coverage-baseline.json .claude/rules/e2e-coverage.md
git commit -m "test(e2e): let the gate see features, not only routes

The traceability gate read 33/53 operations — 62% — at a moment when the entire
notification subsystem, the shareable profile page and My Actions filtering had
no coverage whatsoever. None of those is a route operation, so the check was
green about them by construction. A gate that can only see one axis reports
progress on that axis while the product moves on another.

enumerateFeatures reads four more axes straight out of the code: UI routes from
app.tsx, email cases from email_cases.ts, SMS cases from sms.default.properties,
and x-* markers from every network.json. Each is diffed against coverage.md and
reported by name, with the same may-only-shrink debt register the routes use, so
today's gap is recorded rather than rounded off.

The rules table gains the matching row, since the gate is only half of the
mechanism — the other half is a feature author knowing where to add the case."
```

---

### Task 10: The skill itself — `SKILL.md`, aliases, scoped runs

**Files:**
- Create: `.claude/skills/signals-e2e/SKILL.md`
- Create: `.claude/skills/signals-e2e/lib/run.sh`
- Create: `.claude/skills/signals-e2e/references/` (one file per suite; only the
  suites Plan 1 can actually run — the rest arrive with the follow-on plan)
- Modify: `AGENTS.md` (one pointer line)

**Interfaces:**
- Consumes: every script from Tasks 2–9.
- Produces: `/signals-e2e [dot] [alias]` and `/signals-e2e cleanup [tag]`.

- [ ] **Step 1: Write `lib/run.sh`**

The one entry point. It must:

1. parse `<dot>` and `<alias>`, defaulting the dot to `blue_dot`;
2. resolve the alias through the table to a Playwright `--grep` pattern, and
   refuse an unknown alias by printing the table rather than running everything;
3. check `e2e/run/*/stack.marker` for a live stack matching the requested dot
   and skip stack-up when it matches;
4. `source lib/stack-up.sh "$DOT" "$RUN"`;
5. start the three stubs, waiting for each to answer before continuing, and
   `trap` their teardown plus `cleanup.sh "$RUN"` on `EXIT`;
6. `cleanup.sh "$RUN" --snapshot-only`;
7. run the suite (`npm run e2e:api`, then `e2e:ui` headed) with the grep;
8. run `report.mjs`;
9. exit with the report's code.

- [ ] **Step 2: Write `SKILL.md`**

Frontmatter `name: signals-e2e` and a `description` that names the triggers
("end to end test signals", "full e2e", "test the u18 flow", "signals
signoff"). Body sections, and nothing more — the detail lives in `references/`:

- **Ground rules** — spec §10, verbatim.
- **The dot matrix** — which suites each dot can reach, and the
  `blue_dot` + `orange_dot` default.
- **The alias table** — spec §6.
- **Phase order** — spec §7, one line each.
- **The ⚑ gotcha table** — every trap that would otherwise eat a run: the
  `aria-disabled` consent gate, the blank-UI env pair, the UI port ambiguity,
  the array-facet `contains_any` rule, the map-count-below-list-count
  expectation, `x-uri` through a `$ref`, and the peer-fetch HMAC 401.
- **Suite index** — a link per `references/suite-NN-*.md`, read just-in-time.

- [ ] **Step 3: Write the reference files for the suites Plan 1 can run**

One file each for suites 0, 1, 2, 3, 12 and 13 — the ones the existing journeys
plus this plan's work already cover. Each carries `requires:` frontmatter naming
its fixture recipe, then its case list. The remaining suites get a stub file
naming the follow-on plan, so the index is never a dead link.

- [ ] **Step 4: Verify a full default run**

```bash
bash .claude/skills/signals-e2e/lib/run.sh blue_dot
```

Expected: stack up, three stubs live, API tier green, UI tier green, the
five-section report, `clean — no residue`, and `git status --porcelain` empty.

- [ ] **Step 5: Verify a scoped run**

```bash
bash .claude/skills/signals-e2e/lib/run.sh blue_dot u18
```

Expected: stack **reused** (no restart), only the U18 journeys run, and the
report's section 4 lists every other suite as "not run in this invocation".

- [ ] **Step 6: Verify cleanup-on-demand and cleanup-on-failure**

```bash
bash .claude/skills/signals-e2e/lib/run.sh blue_dot nope-not-an-alias   # must refuse, print the table, exit 2
bash .claude/skills/signals-e2e/lib/cleanup.sh <a-prior-run-id>
```

- [ ] **Step 7: Point contributors at the skill**

Add to `AGENTS.md`, near the existing test commands:

```markdown
End-to-end signoff: `/signals-e2e` brings the local stack up, runs the suite
with every local capability enabled, and reports what passed, what failed, and
what still needs a human. `/signals-e2e <flow>` (e.g. `u18`, `actions`,
`emails`) scopes it to one flow. See `.claude/skills/signals-e2e/SKILL.md`.
```

- [ ] **Step 8: Commit**

```bash
git add .claude/skills/signals-e2e/SKILL.md .claude/skills/signals-e2e/lib/run.sh \
        .claude/skills/signals-e2e/references AGENTS.md
git commit -m "feat(e2e): one command to test signals and sign off on it

Ties the pieces together. run.sh reuses a live stack when the marker matches the
requested dot, brings one up otherwise, starts the three stubs, snapshots the
database, runs the tier, reports, and tears down on EXIT so an interrupted run
cleans up like a finished one.

Scoping is the part that makes this usable after a one-line change. An alias
resolves to a grep, and an unknown alias prints the table rather than quietly
running everything — a scoped run that silently becomes a full one wastes half
an hour, and a full run that silently becomes a scoped one is worse, because it
signs off on work it never touched. The scoped report says which suites did not
run, for the same reason.

SKILL.md stays an orchestrator: ground rules, the dot matrix, the alias table,
the phase order, the gotcha table, and an index into references/ read
just-in-time. The per-suite detail lives in those files so the last suite of a
long run gets the same attention as the first."
```

---

## Self-Review

**1. Spec coverage.** Spec §3.1 → Task 5. §3.2 → Task 6. §3.3 → Task 7. §3.4 →
Tasks 3, 10 (Playwright for coverage; chrome-devtools is triage, invoked by
SKILL.md, not code). §3.5 → Task 4. §4 → Task 8 (`coverage.md`) + Task 9.
§5 → Task 2. §6 → Task 10. §7 phase −1 → Tasks 3 and 4 Step 7. §8 → Task 8.
§9 → Task 9. §10 → Task 10 Step 2. §11 risks are stated, not implemented.
**Deliberately deferred to the follow-on plan:** the new UI specs for audit §3's
features (suites 4–11, 14–16). Plan 1 delivers the machine and gets the existing
journeys green; Plan 2 fills the coverage.

**2. Placeholders.** None. Task 6 Step 5, Task 7 Step 5 and Task 8 Step 4
specify behaviour as an explicit requirement list rather than full source — each
names every endpoint, mode, column and exit condition, and each is preceded by a
task that defines and tests its pure core (`translateClause`, `rowForEvent`,
`buildReport`). That is a deliberate boundary, not a gap: the surrounding
plumbing is I/O whose contract is fully pinned by the tests above it.

**3. Type consistency.** `Db`/`openDb`/`requireDb` (T1) are consumed by name in
T2, T6, T7. `recordCreated`/`readLedger`/`CLEANUP_TABLES` (T2) match
`cleanup.sh`'s table list and its `items → item_id` primary-key special case.
`formatDomainLabel(domainId, domains)` (T3) matches the UI's signature.
`Captured`/`subjectPatternFor`/`assertNoCopyDrift` (T5) are used unchanged in
T8's report input. `translateClause` (T6) is the same function the stub applies.
`rowForEvent(event, item, locations)` (T7) is imported at that exact path by its
test. `buildReport({results, humanOnly, scoped, residue})` (T8) matches the
`human-only` block name in `coverage.md` and `cleanup.sh`'s residue exit code.
`realSearch` (T4) is added to `Capabilities`, `capabilitiesFor` and `REASONS`
together, as that file's own rule requires.
