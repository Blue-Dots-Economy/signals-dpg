# Single-Domain Lock (refactor of PR #51) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock each user to a single domain (e.g. `seeker` *or* `provider`) per network, enforced server-side by deriving the lock from the user's existing items — no new DB column, no new endpoint, no new request params — and add the `provider → provider` interaction so providers can also discover and act on other providers.

**Architecture:** A user's domain is *implied by the items they have already created* in a network, not stored on the `user` row. A small pure helper (`resolveDomainLock`) decides allow/deny from the distinct `item_domain`s the user already holds; the `create_item` handler calls it after a single `SELECT DISTINCT`. The UI drives its create flow off the already-fetched `myItems` (offer all served domains when empty, lock to the held domain otherwise). Discovery of `provider → provider` needs only a complete interaction block added to each `network.json` — both the UI (`visibleDomains`, browse fetch, action resolution) and the server (`getActionInteraction`) already resolve interactions generically.

**Tech Stack:** Fastify + Drizzle ORM (Postgres) on `apps/api`; React + Vite + React Router on `apps/ui`; Vitest for tests; JSON-Schema-driven `network.json` configs in `examples/schemas/`.

---

## Context: what this replaces

PR #51 (`feat/user-network-membership`, parked) solved single-domain-lock by persisting membership on the `user` row as a `domains text[]` column, with a `join-network` endpoint, a `NetworkJoinGate` modal, a `domains[]` param on OTP verify, and a raw-SQL `text[]` serialization workaround. That machinery is built for **multi-network** membership; the product is **single-network, single-instance**, so it is over-built and carries a migration + endpoint + serialization-bug surface we don't need.

**Discard from #51** (do not carry forward):
- `domains text[]` column on `user` + `user_domains_gin_idx` + the `auth.sql` / bundled-schema migration.
- `POST /api/auth/unified-otp/join-network` endpoint and the cookie-cache refresh added for it.
- `domains: string[]` body extension on `POST /api/auth/unified-otp/verify` and its raw-SQL `'{...}'::text[]` write path.
- `apps/ui/src/components/auth/network-join-gate.tsx` (the gate modal) and its mount in `app.tsx`.
- `useMyNetworks` / `useJoinNetwork` domain-parsing in `apps/ui/src/hooks/use-my-networks.ts` and the `domains[]` plumbing in `auth-context.tsx` / `auth-api.ts`.
- The `DOMAIN_MISMATCH` / membership check that #51 added to `POST /api/v1/admin/participant` (the admin path keeps its existing behavior; admin api-key callers bypass the lock — see Task 2).

**Keep from #51** — these are orthogonal, independently-useful fixes that happened to be bundled in. Land them as **separate small PRs**, not in this plan (listed in the Appendix): phone normalization (`normalizePhoneNumber` / `isValidPhoneNumber`), modal/dropdown z-index bumps over map panes, `theme-provider` served-network discovery + first-served fallback (with the `VITE_NETWORK_ID` pre-seed removed).

**Ground-truth references verified before writing this plan:**
- `apps/api/src/routes/v1/item/create_item.ts` — `create_item_handler`, the `isAdminApiCaller` carve-out, `userId` resolution, `isServedDomainBinding` guard, `createItemInternal` call.
- `apps/api/src/routes/v1/item/fetch_item.ts:48,81` — `/item/fetch` is already hard-scoped to `created_by: userId`.
- `apps/ui/src/pages/home-page.tsx:231-292` — `myItems` fetch across served domains, `currentDomain` derivation, and `visibleDomains` computed as the `to_domain`s of interactions whose `from_domain === currentDomain`.
- `packages/schemas/src/network_workflow.ts:361-396` — `getActionInteraction` resolves an interaction generically by `(from_domain, to_domain)`.
- `examples/schemas/{blue_dot,purple_dot}/network.json` — `actions.<type>.interactions[]` shape.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `apps/api/src/routes/v1/item/resolve_domain_lock.ts` | Pure allow/deny decision from existing domains | **Create** |
| `apps/api/src/routes/v1/item/__tests__/resolve_domain_lock.test.ts` | Unit tests for the helper | **Create** |
| `apps/api/src/routes/v1/item/create_item.ts` | Call the helper after a `SELECT DISTINCT`; 403 `DOMAIN_LOCKED` | **Modify** |
| `examples/schemas/blue_dot/network.json` | Add `provider → provider` interaction | **Modify** |
| `examples/schemas/purple_dot/network.json` | Add `provider → provider` interaction | **Modify** |
| `helmcharts/dpg/charts/api/files/schema.sql` | (No change — we are *not* adding a column) | — |
| `apps/ui/src/pages/profile-form-page.tsx` | Offer all served domains when `myItems` empty; lock to held domain otherwise | **Modify** |
| `apps/ui/src/app.tsx` | Remove `<NetworkJoinGate />` mount | **Modify** |
| `apps/ui/src/components/auth/network-join-gate.tsx` | Delete | **Delete** |

---

## Task 1: Pure domain-lock decision helper

**Files:**
- Create: `apps/api/src/routes/v1/item/resolve_domain_lock.ts`
- Test: `apps/api/src/routes/v1/item/__tests__/resolve_domain_lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/v1/item/__tests__/resolve_domain_lock.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDomainLock } from '../resolve_domain_lock';

describe('resolveDomainLock', () => {
  it('allows any domain when the user holds no items yet', () => {
    expect(resolveDomainLock([], 'seeker')).toEqual({
      allowed: true,
      lockedDomain: null,
    });
  });

  it('allows creating in the domain the user already holds', () => {
    expect(resolveDomainLock(['provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'provider',
    });
  });

  it('denies a different domain than the one held', () => {
    expect(resolveDomainLock(['seeker'], 'provider')).toEqual({
      allowed: false,
      lockedDomain: 'seeker',
    });
  });

  it('deduplicates repeated domains (multiple items, one domain)', () => {
    expect(resolveDomainLock(['provider', 'provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'provider',
    });
  });

  it('tolerates legacy dirty data spanning two domains by allowing any held domain', () => {
    expect(resolveDomainLock(['seeker', 'provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'seeker',
    });
    expect(resolveDomainLock(['seeker', 'provider'], 'student').allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/resolve_domain_lock.test.ts`
Expected: FAIL — `Cannot find module '../resolve_domain_lock'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/routes/v1/item/resolve_domain_lock.ts
export interface DomainLockResult {
  /** True when the requested domain is allowed for this user in this network. */
  allowed: boolean;
  /**
   * The domain the user is already locked to (first distinct held domain),
   * or null when the user holds no items yet. Used only for the 403 message.
   */
  lockedDomain: string | null;
}

/**
 * A user is locked to a single domain per network: the domain of the items
 * they have already created there. The lock is derived live from the items
 * table — there is no membership column. An empty set means "not yet locked",
 * so any served domain is allowed. Deleting all of a user's items in a network
 * empties the set and releases the lock (changeable-when-empty semantics).
 *
 * `existingDomains` may contain duplicates (a provider with a profile plus
 * several job postings) — dedupe before deciding. It may, for legacy/dirty
 * rows, contain more than one distinct domain; in that case we allow any
 * already-held domain and report the first for messaging.
 */
export function resolveDomainLock(
  existingDomains: string[],
  requestedDomain: string,
): DomainLockResult {
  const distinct = [...new Set(existingDomains)];
  if (distinct.length === 0) {
    return { allowed: true, lockedDomain: null };
  }
  return {
    allowed: distinct.includes(requestedDomain),
    lockedDomain: distinct[0],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/resolve_domain_lock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/item/resolve_domain_lock.ts apps/api/src/routes/v1/item/__tests__/resolve_domain_lock.test.ts
git commit -m "feat(item): pure resolveDomainLock helper for single-domain lock"
```

---

## Task 2: Enforce the lock in `create_item`

**Files:**
- Modify: `apps/api/src/routes/v1/item/create_item.ts`

The guard runs only for non-admin callers (admin api-key callers act on behalf of a user with explicit intent and keep their bypass, consistent with the existing `isAdminApiCaller` carve-out). It goes **after** the `isServedDomainBinding` check and **before** `ensureItemPartition`.

- [ ] **Step 1: Extend the drizzle import and add the `items` + helper imports**

Change the existing import line:

```ts
import { DrizzleQueryError } from 'drizzle-orm';
```

to:

```ts
import { DrizzleQueryError, and, eq } from 'drizzle-orm';
```

and add, alongside the other imports at the top of `create_item.ts`:

```ts
import { items } from '@dpg/database';
import { resolveDomainLock } from './resolve_domain_lock';
```

- [ ] **Step 2: Insert the lock guard**

Locate the served-domain check in `create_item_handler`:

```ts
  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }
```

Immediately **after** that block, insert:

```ts
  // Single-domain lock: a user may only create items in the one domain they
  // already hold within this network. The lock is derived live from the items
  // table (no membership column). Admin api-key callers bypass — they act on
  // behalf of a user with explicit intent. Empty set => not yet locked, so any
  // served domain is allowed; deleting all their items releases the lock.
  if (!isAdminApiCaller) {
    const heldRows = await db
      .selectDistinct({ item_domain: items.item_domain })
      .from(items)
      .where(
        and(
          eq(items.created_by, userId),
          eq(items.item_network, body.item_network),
        ),
      );

    const lock = resolveDomainLock(
      heldRows.map((r) => r.item_domain),
      body.item_domain,
    );

    if (!lock.allowed) {
      return reply.code(403).send({
        error: 'DOMAIN_LOCKED',
        message: `You are registered as "${lock.lockedDomain}" in "${body.item_network}" and cannot create items under "${body.item_domain}".`,
        locked_domain: lock.lockedDomain,
        requested_domain: body.item_domain,
      });
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: 0 errors. (If `items` is not exported from `@dpg/database`, import it from `@api/db/postgres/schema` instead — verify the existing `fetch_item.ts` import path for the `items` table and match it.)

- [ ] **Step 4: Manual integration verification against the local stack**

Prereq: `docker compose up -d db redis`, API running with `SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"` and a valid session cookie/token for a fresh user (`CREATE_TEST_OTP=true` → OTP `000000`).

```bash
# 1. Fresh user creates a seeker profile — expect 201
curl -s -X POST localhost:2742/api/v1/item/create \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"item_network":"blue_dot","item_domain":"seeker","item_type":"profile_1.0","item_state":{}}' | jq

# 2. Same user attempts a provider item — expect 403 DOMAIN_LOCKED
curl -s -X POST localhost:2742/api/v1/item/create \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"item_network":"blue_dot","item_domain":"provider","item_type":"profile_1.0","item_state":{}}' | jq

# 3. Same user creates a SECOND seeker item — expect 201 (one domain, many items)
curl -s -X POST localhost:2742/api/v1/item/create \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"item_network":"blue_dot","item_domain":"seeker","item_type":"profile_1.0","item_state":{}}' | jq
```

Expected: (1) `201 {item_id,...}`, (2) `403 {"error":"DOMAIN_LOCKED","locked_domain":"seeker",...}`, (3) `201`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/item/create_item.ts
git commit -m "feat(item): enforce single-domain lock in create_item via items table"
```

> **Known limitation (accepted for the single-instance pilot, do not silently ignore):** the check is read-then-write, so two concurrent creates in different domains could both pass (TOCTOU). Closing it would need a partial unique constraint on `(created_by, item_network)` — a schema change explicitly out of scope here. Note it in the PR description; revisit if abuse appears.

---

## Task 3: Add the `provider → provider` interaction to both network configs

This is the **only** change needed for providers to discover and act on other providers — UI `visibleDomains`/browse/action-resolution and server `getActionInteraction` are all interaction-driven. The block must be **complete** (all sub-schemas + consent copy), not a stub.

**Files:**
- Modify: `examples/schemas/blue_dot/network.json`
- Modify: `examples/schemas/purple_dot/network.json`

- [ ] **Step 1 (blue_dot): add a `connect` action with the provider→provider interaction**

In `examples/schemas/blue_dot/network.json`, the `"actions"` object currently has one key, `"apply"` (seeker↔provider hiring). Add a sibling `"connect"` action. Insert this as a new key inside `"actions"` (mind the trailing comma after the existing `"apply"` block):

```json
    "connect": {
      "description": "Lets a provider connect with another provider (partnership / referral). Either party can initiate; the receiver can accept or reject.",
      "interactions": [
        {
          "from_network": "blue_dot",
          "from_domain": "provider",
          "to_network": "blue_dot",
          "to_domain": "provider",
          "requirement_schema": { "type": "object", "properties": {} },
          "event_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Provider To Provider Connect Event",
            "type": "object",
            "additionalProperties": false,
            "required": ["status", "remark"],
            "properties": {
              "status": {
                "type": "string",
                "enum": ["created", "accepted", "rejected", "cancelled"]
              },
              "remark": { "type": "string" }
            }
          },
          "metric_categories": null,
          "reveals_pii_on_status": ["accepted"],
          "consent_text_initiator": "I agree to share my organisation's contact details with this organisation if they accept my request.",
          "consent_text_receiver": "I agree to share my organisation's contact details with the requester."
        }
      ]
    }
```

> `metric_categories` is `null` so this direction stays out of the seeker→provider dashboard rollup (consistent with the metrics design's pilot scope). If product later wants provider↔provider in the dashboard, populate it then — and check `findMetricCategoryAsymmetries` in `packages/schemas/src/network_workflow.ts` does not flag an asymmetry.

- [ ] **Step 2 (purple_dot): add the provider→provider interaction into the existing `connect` action**

In `examples/schemas/purple_dot/network.json`, the `"connect"` action already has two interactions (seeker→provider, provider→seeker). Append a third interaction object to that `interactions` array (add a comma after the current last interaction):

```json
        {
          "from_network": "purple_dot",
          "from_domain": "provider",
          "to_network": "purple_dot",
          "to_domain": "provider",
          "requirement_schema": { "type": "object", "properties": {} },
          "event_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Provider To Provider Connect Event",
            "type": "object",
            "additionalProperties": false,
            "required": ["status", "remark"],
            "properties": {
              "status": {
                "type": "string",
                "enum": ["created", "accepted", "rejected", "cancelled"]
              },
              "remark": { "type": "string" }
            }
          },
          "metric_categories": null,
          "reveals_pii_on_status": ["accepted"],
          "consent_text_initiator": "I agree to share my contact details with this provider if they accept my request.",
          "consent_text_receiver": "I agree to share my contact details with the requester."
        }
```

- [ ] **Step 3: Validate both JSON files parse and conform**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('examples/schemas/blue_dot/network.json','utf8')); JSON.parse(require('fs').readFileSync('examples/schemas/purple_dot/network.json','utf8')); console.log('both parse OK')"
pnpm --filter api exec vitest run -t "network" 2>/dev/null || true
```
Expected: `both parse OK`. If a schema-validation unit test for network configs exists, it should stay green (the interaction schema requires `from_domain`/`to_domain`, both present).

- [ ] **Step 4: Verify server interaction resolution (no code change expected)**

Start the API with `SERVED_DOMAINS="blue_dot/provider"` (or purple equivalent), then confirm `GET /api/v1/network/schema/...` / action-fetch surfaces the new pair. Quick assertion via the existing helper:

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts
```
Expected: existing action tests still PASS (generic `getActionInteraction` unaffected).

- [ ] **Step 5: Commit**

```bash
git add examples/schemas/blue_dot/network.json examples/schemas/purple_dot/network.json
git commit -m "feat(config): add provider->provider connect interaction (blue_dot, purple_dot)"
```

---

## Task 4: UI — drive the create flow off `myItems`, remove the join gate

The detection mechanism already exists: `home-page.tsx` fetches `myItems` across all served domains. The create flow must offer all served domains only when the user has no items, and lock to the held domain otherwise. The `NetworkJoinGate` modal (multi-network) is removed.

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`
- Modify: `apps/ui/src/app.tsx`
- Delete: `apps/ui/src/components/auth/network-join-gate.tsx`

- [ ] **Step 1: Remove the gate mount from `app.tsx`**

Delete the import and the `<NetworkJoinGate />` element:

```ts
// REMOVE this import line:
import { NetworkJoinGate } from '@/components/auth/network-join-gate';
```
```tsx
{/* REMOVE this element (was rendered above <Routes>): */}
<NetworkJoinGate />
```

- [ ] **Step 2: Delete the gate component**

```bash
git rm apps/ui/src/components/auth/network-join-gate.tsx
```

- [ ] **Step 3: Make the profile-form domain selection lock-aware**

In `apps/ui/src/pages/profile-form-page.tsx`, the domain to create under must come from the user's existing items when present. Fetch the user's items (reuse `fetchItems` with `created_by_me: true` across the network's served domains, mirroring `home-page.tsx:236-246`) and compute the locked domain:

```tsx
import { fetchItems, type Item } from '@/lib/item-api';
// ...
const [myItems, setMyItems] = React.useState<Item[]>([]);

React.useEffect(() => {
  if (!network || !user) return;
  const controller = new AbortController();
  Promise.all(
    network.domains.map((domain) =>
      fetchItems(
        {
          item_network: network.id,
          item_domain: domain.id,
          item_type: getItemTypeForDomain(network, domain.id),
          created_by_me: true,
          limit: 100,
        },
        controller.signal,
      )
        .then((res) => res.items)
        .catch(() => [] as Item[]),
    ),
  ).then((results) => {
    if (!controller.signal.aborted) setMyItems(results.flat());
  });
  return () => controller.abort();
}, [network, user]);

// Domain the user is locked to, or null when they hold no items yet.
const lockedDomain = React.useMemo(
  () => (myItems.length > 0 ? myItems[0].item_domain : null),
  [myItems],
);

// Domains offered in the picker: only the locked one when locked, else all
// served domains (network.domains is already filtered to served by config).
const selectableDomains = React.useMemo(
  () =>
    lockedDomain
      ? network?.domains.filter((d) => d.id === lockedDomain) ?? []
      : network?.domains ?? [],
  [lockedDomain, network],
);
```

Then: (a) initialize `selectedDomain` to `lockedDomain` when set; (b) render the domain picker from `selectableDomains` (so a locked user sees only their domain, and within it can still pick the `item_type` if the domain exposes more than one schema, e.g. provider's `profile` + `job_posting`); (c) keep the existing schema/form resolution which already reads `domain.item_schemas`.

> The server guard (Task 2) is the real enforcement; this step just avoids ever *presenting* an illegal choice and avoids relying on browser cache as the source of truth.

- [ ] **Step 4: Typecheck and build the UI**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: 0 errors. (No reference to the deleted `NetworkJoinGate` or `useJoinNetwork` should remain — grep to confirm: `grep -rn "NetworkJoinGate\|useJoinNetwork" apps/ui/src` returns nothing.)

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/app.tsx apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): lock profile-create to held domain via myItems; remove join gate"
```

---

## Task 5: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Single-domain pilot smoke test**

With `SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"`, UI + API running:

1. Fresh user → profile create offers **both** seeker and provider. Pick `provider`, create → lands on home as provider.
2. Provider's browse list now shows **other providers** (Task 3) in addition to seekers — confirm the user's own provider profile is **excluded** from the list (handled by `localProfileItemIds`, `home-page.tsx:307-310,335`).
3. Initiate a connect action provider→provider → action modal opens with the provider→provider `event_schema`; perform succeeds (server `getActionInteraction` resolves the pair).
4. Attempt to create a `seeker` item via the UI → the picker does not offer it; via direct API call → `403 DOMAIN_LOCKED`.
5. Delete all of the user's items → next create offers both domains again (lock released).

- [ ] **Step 2: No-regression check on existing flows**

Seeker→provider apply still works; profile edit of an existing item still works; the home `myItems`/`currentDomain` derivation is unchanged.

- [ ] **Step 3: Run the full unit suites**

```bash
pnpm --filter api test
pnpm --filter ui exec tsc --noEmit
```
Expected: all green.

---

## Appendix: salvage from #51 (separate PRs, not in this plan)

These were bundled into #51 but are independent of the domain-lock work. Cherry-pick each into its own small PR off `feature`:

1. **Phone normalization** — `normalizePhoneNumber` (strip whitespace/dashes/parens) + `isValidPhoneNumber` (accept Indian 10-digit + any E.164) in `apps/ui/src/lib/auth-api.ts`. Fixes legacy `"+91 9876…"` rows that never matched on lookup.
2. **Z-index bumps** — `dialog.tsx` / `select.tsx` / `user-menu.tsx` so modals + dropdowns render above Leaflet/Google map panes. Still relevant after the #52 map work merged.
3. **Theme-provider served-network discovery** — fall back to the first served network instead of hardcoded `blue_dot`, and drop the `VITE_NETWORK_ID` pre-seed that caused phantom `?network=blue_dot` requests. Under single-network this simplifies further (one served network).

## Self-review notes

- **Spec coverage:** server-enforced lock (Tasks 1–2), one-domain/many-items (helper dedup + Step 4.3 of Task 2), changeable-when-empty (helper empty-set path; no reset logic needed), provider→provider discovery (Task 3), UI flow (Task 4), verification (Task 5). All AskUserQuestion decisions covered.
- **No new DB column / endpoint / request param** — honored; `helmcharts/.../schema.sql` intentionally untouched.
- **Type consistency:** `resolveDomainLock(existingDomains: string[], requestedDomain: string): { allowed, lockedDomain }` is used identically in Task 1 and Task 2; `DOMAIN_LOCKED` error code used consistently.
- **Open verification:** Task 2 Step 3 flags the one path-uncertainty (`items` export location) with the exact fallback to check, rather than guessing.
