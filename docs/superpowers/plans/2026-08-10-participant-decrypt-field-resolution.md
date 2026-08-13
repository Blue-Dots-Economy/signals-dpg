# participant/decrypt — field selection + canonical PII resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `fields` selector to `POST /api/v1/admin/participant/decrypt` that returns only the requested fields, resolves canonical `name`/`email`/`phone` from `item_state` via a per-domain `network.json` mapping, and falls back to the `user` (account) row when a canonical field is missing/empty — while leaving today's full-`item_state` behavior intact when `fields` is omitted.

**Architecture:** `network.json` domains gain an optional `contact_fields: { name?, email?, phone? }` map (canonical → the domain's real item_state field). A pure resolver util reads that map (with `name` defaulting to `display_name_field`/`card.title_field`), reads values from the **decrypted merged** state, and falls back to `user.name`/`user.email`/`user.phone_number` for the 3 canonical fields only. The decrypt route wires it in behind the new `fields` param; everything else (auth, ownership, `skipped`) is unchanged.

**Tech Stack:** TypeScript (ESM), Fastify + Zod (`fastify-type-provider-zod`), Drizzle ORM, Vitest. Monorepo: `@dpg/schemas`, `apps/api`.

## Global Constraints

- **Design doc (authority):** `docs/superpowers/specs/2026-08-07-participant-decrypt-field-resolution-design.md`. Read §4 (requirements), §6 (Option A — mapping in `network.json`), §7 (resolver), §13 (risks/accepted).
- **Backward compatible:** `fields` **omitted** ⇒ response is byte-for-byte today's full merged `item_state`. Existing caller (aggregator `fetchDecryptedProfiles`, #579) must be unaffected.
- **`fields` present** ⇒ return **only** those fields (+ the existing envelope `item_id`/`item_network`/`item_domain`/`item_type`/`created_at`/`updated_at`). Raw `item_private_state` ciphertext is never returned (unchanged).
- **Canonical fields = `name`, `email`, `phone` only.** Resolve via `contact_fields` map (name defaults to `display_name_field` → `card.title_field`); read from the **decrypted merged state**; if missing/empty fall back to `user.name`/`user.email`/`user.phone_number`; return under the **canonical key**; `null` if unresolved in both. **Profile value wins** when both item_state and account have a value.
- **Non-canonical requested fields** ⇒ returned from merged `item_state` under their **raw key**, **no** user fallback; **omit** the key when absent.
- **Mapping completeness:** when a canonical `phone`/`email` is requested for a `(network, domain)` with no mapping entry, emit a **PII-free `warn`** (never a silent wrong field). `name` has the `display_name_field`/`title_field` default so it does not warn.
- **No auth/ownership change.** Acting-org + `onboarded_by` scoping and `skipped` semantics unchanged. Never log field values (PII) — counts only.
- **Repo conventions (`AGENTS.md`):** files snake_case; route handlers never throw — `reply.code(N).send({error,message})`; ESM, strict TS, no `any`, `import type` for types; Zod schemas PascalCase.
- **Do not push to protected branches.** Work on `feat/participant-decrypt-field-resolution` (already checked out). Commit per task; do not open a PR (the human will, after creating the signals-dpg issue to replace the `#237`/`#TBD` refs).

## File Structure

- `packages/schemas/src/network_workflow.ts` (modify) — add `ContactFieldsSchema`; add `contact_fields` to `NetworkDomainSchema`.
- `packages/schemas/src/admin/participant_decrypt.ts` (modify) — add optional `fields` to `DecryptParticipantRequest`.
- `apps/api/src/utils/contact_fields.ts` (create) — pure resolver: canonical map resolution + requested-field selection with account fallback.
- `apps/api/src/utils/__tests__/contact_fields.test.ts` (create) — unit tests for the resolver.
- `apps/api/src/routes/v1/admin/participant_decrypt.ts` (modify) — select `user` contact columns; apply the resolver when `fields` present.
- `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.fields.test.ts` (create) — route-level behavior (or colocate per repo norm).
- `examples/schemas/blue_dot/network.json` + `examples/schemas/purple_dot/network.json` (modify) — add `contact_fields` per domain (local dev + tests). Other networks + the canonical bluedots-schemas copies are a follow-up (spec §12).

---

## Task 1: `contact_fields` support in the network-config schema + example data

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts`
- Modify: `examples/schemas/blue_dot/network.json`, `examples/schemas/purple_dot/network.json`
- Test: `packages/schemas/src/__tests__/network_workflow.contact_fields.test.ts` (or the existing network_workflow test file if one exists — match repo norm)

**Interfaces:**
- Produces: `NetworkConfigDocument` domains gain an optional `contact_fields?: { name?: string; email?: string; phone?: string }`. Accessed as `cfg.domains.find(d => d.id === domain)?.contact_fields`.

- [ ] **Step 1: Write the failing test** — create `packages/schemas/src/__tests__/network_workflow.contact_fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseNetworkConfigDocument } from '../network_workflow.js';

const base = {
  id: 'blue_dot',
  domains: [
    {
      id: 'provider',
      item_schemas: {
        'job_posting_1.0': {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          display_name_field: 'jobProviderName',
          properties: { jobProviderName: { type: 'string' } },
        },
      },
      card: { title_field: 'jobProviderName' },
      contact_fields: {
        name: 'jobProviderName',
        phone: 'hiringManagerPhoneNumber',
        email: 'hiringManagerEmail',
      },
    },
  ],
};

describe('network config contact_fields', () => {
  it('parses and exposes a domain contact_fields map', () => {
    const cfg = parseNetworkConfigDocument(base);
    const provider = cfg.domains.find((d) => d.id === 'provider');
    expect(provider?.contact_fields).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
  });

  it('treats contact_fields as optional (absent → undefined)', () => {
    const noContact = { ...base, domains: [{ ...base.domains[0], contact_fields: undefined }] };
    const cfg = parseNetworkConfigDocument(noContact);
    expect(cfg.domains[0]!.contact_fields).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/network_workflow.contact_fields.test.ts`
Expected: FAIL — `contact_fields` is stripped (domain schema is strip-mode) so it's `undefined`, first assertion fails.

- [ ] **Step 3: Implement.** In `packages/schemas/src/network_workflow.ts`, add the schema just **after** `CardConfigSchema` (ends ~line 89):

```ts
/**
 * Canonical contact-field mapping for a domain (#237): maps the canonical
 * name/email/phone to the domain's real item_state field name, since these
 * are named differently per network/domain (e.g. `mobile_number`,
 * `hiringManagerPhoneNumber`). Consumed by participant/decrypt field
 * resolution. All optional — `name` falls back to display_name_field /
 * card.title_field when unset.
 */
const ContactFieldsSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
  })
  .strict();
```

Then add `contact_fields` to `NetworkDomainSchema` (the `z.object({...})` at ~line 91-123), as a sibling of `card` (e.g. immediately after the `card: CardConfigSchema.optional(),` line):

```ts
    contact_fields: ContactFieldsSchema.optional(),
```

- [ ] **Step 4: Add example data.** In `examples/schemas/blue_dot/network.json`, add a `contact_fields` block as a sibling of each domain's `card`:
  - seeker domain (after its `card` block, ~line 780):
    ```json
    "contact_fields": { "name": "name", "phone": "phone" },
    ```
    (blue_dot seeker has no profile email — email resolves via the account fallback.)
  - provider domain (after its `card` block, ~line 1318):
    ```json
    "contact_fields": { "name": "jobProviderName", "phone": "hiringManagerPhoneNumber", "email": "hiringManagerEmail" },
    ```
    ⚠️ Verify these provider field names exist in the provider `job_posting_1.0` schema; if the actual private phone/email fields are named differently, use the real names (the mapping must point at real fields).

  In `examples/schemas/purple_dot/network.json`:
  - seeker domain: `"contact_fields": { "name": "beneficiary_name", "phone": "mobile_number", "email": "email" },`
  - provider domain: `"contact_fields": { "name": "contact_name", "phone": "contact_phone", "email": "contact_email" },`

- [ ] **Step 5: Run tests + full schema suite**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/network_workflow.contact_fields.test.ts`
Then: `pnpm --filter @dpg/schemas test` (ensure no existing network-config test broke on the new field).
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @dpg/schemas typecheck
git add packages/schemas/src/network_workflow.ts packages/schemas/src/__tests__/network_workflow.contact_fields.test.ts \
        examples/schemas/blue_dot/network.json examples/schemas/purple_dot/network.json
git commit -m "feat(network-config): add per-domain contact_fields mapping (#237)"
```

---

## Task 2: `fields` param on the decrypt request schema

**Files:**
- Modify: `packages/schemas/src/admin/participant_decrypt.ts`
- Test: `packages/schemas/src/admin/__tests__/participant_decrypt.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `DecryptParticipantRequest` gains optional `fields?: string[]` (1..50 non-empty strings). `DecryptParticipantRequest` type updated via `z.infer`.

- [ ] **Step 1: Write failing tests** — append to `packages/schemas/src/admin/__tests__/participant_decrypt.test.ts`:

```ts
describe('DecryptParticipantRequest.fields', () => {
  it('accepts an optional fields array', () => {
    const r = DecryptParticipantRequest.parse({ item_ids: [crypto.randomUUID()], fields: ['name', 'phone'] });
    expect(r.fields).toEqual(['name', 'phone']);
  });
  it('is valid when fields omitted (backward compatible)', () => {
    const r = DecryptParticipantRequest.parse({ item_ids: [crypto.randomUUID()] });
    expect(r.fields).toBeUndefined();
  });
  it('rejects empty-string field entries', () => {
    expect(() => DecryptParticipantRequest.parse({ user_id: 'u1', fields: [''] })).toThrow();
  });
});
```
(Ensure `DecryptParticipantRequest` is imported at the top of the file if not already.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @dpg/schemas exec vitest run src/admin/__tests__/participant_decrypt.test.ts -t "fields"`
Expected: FAIL — `fields` not on the schema (unknown key stripped → first assertion fails).

- [ ] **Step 3: Implement.** In `packages/schemas/src/admin/participant_decrypt.ts`, add `fields` to the `DecryptParticipantRequest` object (keep the existing `.refine` for exactly-one selector):

```ts
export const DecryptParticipantRequest = z
  .object({
    item_ids: z.array(z.uuid()).min(1).optional(),
    user_id: z.string().min(1).optional(),
    // #237: optional field selector. Omitted => full item_state (today's
    // behavior). Present => only these fields returned. Canonical name/email/
    // phone are resolved via the domain contact_fields map with user-table
    // fallback; other names are read from item_state as-is.
    fields: z.array(z.string().min(1)).min(1).max(50).optional(),
  })
  .refine(
    (b) => (b.item_ids ? 1 : 0) + (b.user_id ? 1 : 0) === 1,
    { message: 'exactly one of item_ids or user_id is required' },
  );
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @dpg/schemas exec vitest run src/admin/__tests__/participant_decrypt.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @dpg/schemas typecheck
git add packages/schemas/src/admin/participant_decrypt.ts packages/schemas/src/admin/__tests__/participant_decrypt.test.ts
git commit -m "feat(schemas): add optional fields selector to DecryptParticipantRequest (#237)"
```

---

## Task 3: contact-field resolver util (pure, dependency-free)

**Files:**
- Create: `apps/api/src/utils/contact_fields.ts`
- Test: `apps/api/src/utils/__tests__/contact_fields.test.ts`

**Interfaces:**
- Consumes: nothing app-runtime — takes plain data so it's trivially unit-testable.
- Produces:
  - `type CanonicalContact = 'name' | 'email' | 'phone'`
  - `interface ContactLog { warn(obj: object, msg: string): void }`
  - `interface DomainContactContext { network: string; domain: string; itemType: string; contactFields?: { name?: string; email?: string; phone?: string }; nameFallbackField?: string }` — `nameFallbackField` = the item-type `display_name_field` or domain `card.title_field`, resolved by the caller.
  - `interface AccountContact { name?: string | null; email?: string | null; phone?: string | null }`
  - `function selectRequestedFields(mergedState: Record<string, unknown>, account: AccountContact, fields: string[], ctx: DomainContactContext, log: ContactLog): Record<string, unknown>` — returns the filtered item_state per the rules (canonical under canonical keys with fallback + `null`; non-canonical raw, omitted when absent).

- [ ] **Step 1: Write failing tests** — create `apps/api/src/utils/__tests__/contact_fields.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { selectRequestedFields, type DomainContactContext } from '../contact_fields.js';

const log = { warn: vi.fn() };
const ctxBlueSeeker: DomainContactContext = {
  network: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0',
  contactFields: { name: 'name', phone: 'phone' }, // no email mapping (account-only)
  nameFallbackField: 'name',
};

describe('selectRequestedFields', () => {
  it('returns canonical fields from item_state under canonical keys', () => {
    const out = selectRequestedFields(
      { name: 'Asha', phone: '+9190', gender: 'F' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['name', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ name: 'Asha', phone: '+9190' }); // profile wins; gender not requested
  });

  it('falls back to account when the canonical field is missing/empty in item_state', () => {
    const out = selectRequestedFields(
      { name: 'Asha', phone: '' }, // phone empty, no email field in blue_dot seeker
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['email', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ email: 'a@x.com', phone: '+9100' });
  });

  it('returns null for a canonical field absent in both item_state and account', () => {
    const out = selectRequestedFields(
      { name: 'Asha' },
      { name: 'acct', email: null, phone: null },
      ['email'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ email: null });
  });

  it('returns non-canonical fields raw and omits absent ones (no account read)', () => {
    const out = selectRequestedFields(
      { gender: 'F', age: '23' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['gender', 'missingField'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ gender: 'F' });
  });

  it('resolves name via nameFallbackField when contact_fields.name is unset', () => {
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {}, nameFallbackField: 'beneficiary_name' };
    const out = selectRequestedFields(
      { beneficiary_name: 'Meena' }, { name: 'acct', email: null, phone: null }, ['name'], ctx, log,
    );
    expect(out).toEqual({ name: 'Meena' });
  });

  it('warns when a phone/email canonical field has no mapping and no fallback', () => {
    log.warn.mockClear();
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {} };
    selectRequestedFields({}, { name: null, email: null, phone: null }, ['phone'], ctx, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter api exec vitest run src/utils/__tests__/contact_fields.test.ts`
Expected: FAIL — `../contact_fields.js` does not exist.

- [ ] **Step 3: Implement** — create `apps/api/src/utils/contact_fields.ts`:

```ts
/**
 * Resolver for participant/decrypt field selection (#237). Pure functions:
 * given a decrypted merged item_state, the participant's account contact, the
 * requested fields, and the domain's contact-field context, produce the
 * filtered item_state. Canonical name/email/phone are mapped to the domain's
 * real field and fall back to the account row; other fields are read raw.
 */

export type CanonicalContact = 'name' | 'email' | 'phone';
const CANONICAL: readonly CanonicalContact[] = ['name', 'email', 'phone'];

/** Minimal pino-compatible surface for PII-free warnings. */
export interface ContactLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Per-(network,domain,item_type) resolution context, assembled by the caller. */
export interface DomainContactContext {
  network: string;
  domain: string;
  itemType: string;
  /** The domain's `contact_fields` map from network.json, if any. */
  contactFields?: { name?: string; email?: string; phone?: string };
  /** Fallback field name for `name`: item-type display_name_field or card.title_field. */
  nameFallbackField?: string;
}

/** The participant's account (user-row) contact, for canonical fallback. */
export interface AccountContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

const isCanonical = (f: string): f is CanonicalContact =>
  (CANONICAL as readonly string[]).includes(f);

/** True when a value is present and non-empty (empty string / whitespace = absent). */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/** The item_state field name for a canonical concept in this domain. */
function mappedField(ctx: DomainContactContext, f: CanonicalContact): string | undefined {
  const explicit = ctx.contactFields?.[f];
  if (explicit) return explicit;
  if (f === 'name') return ctx.nameFallbackField; // display_name_field / card.title_field
  return undefined; // phone/email have no default — mapping is required
}

/**
 * Builds the filtered item_state for the requested `fields`.
 *
 * @param mergedState - The DECRYPTED merged item_state (public + decrypted private).
 * @param account - The item creator's account contact (fallback source, 3 fields only).
 * @param fields - Requested field names (canonical name/email/phone + raw field names).
 * @param ctx - Domain contact-field context.
 * @param log - PII-free warning sink for missing canonical mappings.
 * @returns Filtered object: canonical under canonical keys (value or null),
 *   non-canonical under raw keys (omitted when absent).
 */
export function selectRequestedFields(
  mergedState: Record<string, unknown>,
  account: AccountContact,
  fields: string[],
  ctx: DomainContactContext,
  log: ContactLog,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const accountByCanonical: Record<CanonicalContact, string | null | undefined> = {
    name: account.name,
    email: account.email,
    phone: account.phone,
  };

  for (const f of fields) {
    if (isCanonical(f)) {
      const fieldName = mappedField(ctx, f);
      const fromState = fieldName ? mergedState[fieldName] : undefined;
      if (hasValue(fromState)) {
        out[f] = fromState; // profile wins
        continue;
      }
      if (!fieldName && (f === 'phone' || f === 'email')) {
        log.warn(
          { operation: 'participant.decrypt.contact_map_missing', network: ctx.network, domain: ctx.domain, field: f },
          'no contact_fields mapping for requested canonical field; using account fallback',
        );
      }
      const fromAccount = accountByCanonical[f];
      out[f] = hasValue(fromAccount) ? fromAccount : null;
    } else {
      // non-canonical: raw item_state value, no fallback, omit when absent
      if (Object.prototype.hasOwnProperty.call(mergedState, f) && hasValue(mergedState[f])) {
        out[f] = mergedState[f];
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter api exec vitest run src/utils/__tests__/contact_fields.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter api typecheck
git add apps/api/src/utils/contact_fields.ts apps/api/src/utils/__tests__/contact_fields.test.ts
git commit -m "feat(api): contact-field resolver util for decrypt field selection (#237)"
```

---

## Task 4: wire the resolver into the decrypt route

**Files:**
- Modify: `apps/api/src/routes/v1/admin/participant_decrypt.ts`
- Test: `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.fields.test.ts` (integration; requires db — mark `.integration.test.ts` if it needs Postgres, per repo rule) OR a handler-level unit test that stubs the db query results. Prefer a focused unit/handler test if the route is unit-testable; otherwise integration.

**Interfaces:**
- Consumes: `selectRequestedFields`, `DomainContactContext` (Task 3); `getNetworkConfigById` (`apps/api/src/network_configs.ts`); `user` columns (`name`, `email`, `phoneNumber`) from the auth schema (already imported).
- Produces: the route returns filtered `item_state` when `request.body.fields` is set; unchanged otherwise.

- [ ] **Step 1: Write the failing test.** Add a test asserting: (a) `fields` omitted → full merged state (regression); (b) `fields: ['name','phone']` on a blue_dot seeker → only those keys, real (unmasked) values; (c) `fields: ['email']` where the profile has no email → account email via fallback; (d) canonical absent in both → `null`. Model DB/seed setup on the existing `participant_decrypt` integration/handler test. (Author against the existing test harness for this route; if none, create the integration test that seeds one user+item and calls the handler.)

Run it and confirm it fails (filtering not implemented).

- [ ] **Step 2: Implement — select account columns.** In `participant_decrypt.ts`, extend the select to include the creator's account contact. Change both `db.select(ITEM_COLUMNS)` queries to also select user columns, e.g. define:

```ts
const SELECT_COLUMNS = {
  ...ITEM_COLUMNS,
  user_name: user.name,
  user_email: user.email,
  user_phone: user.phoneNumber,
} as const;
```
and use `db.select(SELECT_COLUMNS)` in both the `item_ids` and `user_id` branches. Extend `DecryptableRow` with `user_name: string | null; user_email: string | null; user_phone: string | null;`.

- [ ] **Step 3: Implement — apply the resolver.** After a snapshot is built (in/after `toSnapshotSafe`), when `body.fields` is present, replace `snapshot.item_state` with the filtered result. Resolve the per-domain context from network config (cache per network within the handler). Sketch:

```ts
import { getNetworkConfigById } from '@/network_configs';
import { selectRequestedFields, type DomainContactContext } from '@/utils/contact_fields';

// inside the handler, before iterating rows:
const fields = body.fields;
const cfgCache = new Map<string, Awaited<ReturnType<typeof getNetworkConfigById>>>();
const getCfg = async (network: string) => {
  let c = cfgCache.get(network);
  if (!c) { c = await getNetworkConfigById(network); cfgCache.set(network, c); }
  return c;
};

// build the context for a row (only when fields requested):
async function contextFor(r: DecryptableRow): Promise<DomainContactContext> {
  const cfg = await getCfg(r.item_network);
  const domainCfg = cfg.domains.find((d) => d.id === r.item_domain);
  const schema = domainCfg?.item_schemas?.[r.item_type] as { display_name_field?: unknown } | undefined;
  const nameFallbackField =
    (typeof schema?.display_name_field === 'string' ? schema.display_name_field : undefined) ??
    (domainCfg?.card?.title_field as string | undefined);
  return {
    network: r.item_network,
    domain: r.item_domain,
    itemType: r.item_type,
    contactFields: domainCfg?.contact_fields,
    ...(nameFallbackField ? { nameFallbackField } : {}),
  };
}
```
Then, when building each profile: if `fields` present, compute the context and set
```ts
snapshot.item_state = selectRequestedFields(
  snapshot.item_state as Record<string, unknown>,
  { name: r.user_name, email: r.user_email, phone: r.user_phone },
  fields,
  await contextFor(r),
  request.log,
);
```
Keep the existing `skipped` handling and the "no fields → full merged state" path exactly as-is. Do not change auth, ownership, or the audit log except optionally adding `fields_requested: fields?.length` (counts only, never values) to the existing `request.log.info`.

- [ ] **Step 4: Run the route test + verify.** Focused run of the new test file, then `pnpm --filter api typecheck`. Confirm the omitted-`fields` regression assertion passes (full state unchanged).

- [ ] **Step 5: Full check + commit**

```bash
pnpm --filter api typecheck
pnpm --filter api test   # unit; run the integration file explicitly if it needs db + redis
git add apps/api/src/routes/v1/admin/participant_decrypt.ts apps/api/src/routes/v1/admin/__tests__/participant_decrypt.fields.test.ts
git commit -m "feat(api): resolve requested fields + account fallback in participant/decrypt (#237)"
```

---

## Post-implementation

- **Manual verify** (local stack, service key + `x-acting-org-id`):
  - `fields` omitted → full `item_state` (unchanged).
  - `fields:["name","phone"]` on a blue_dot seeker → only those, real values.
  - `fields:["email"]` on a blue_dot seeker (no profile email) → account email.
  - A purple_dot seeker → `name`/`phone`/`email` resolve from `beneficiary_name`/`mobile_number`/`email`.
- **Cross-repo follow-up (spec §12):** add `contact_fields` to the canonical **bluedots-schemas** `network.json` copies (and any other served networks: orange_dot, yellow_dot) so prod resolves correctly; the mapping-completeness `warn` will flag any served domain still missing it.
- **Consumers (separate tickets):** aggregator `signalstack-writer.fetchDecryptedProfiles` gains a `fields` arg; #577 sends `["phone","name"]`, #578 sends `["email","name"]`; #579 unchanged.
- Replace `#237`/`#TBD` issue refs once the signals-dpg issue is created.

## Self-Review notes (author)
- Spec coverage: §4.1 (Task 2 + Task 4), §4.2 canonical mapping + fallback (Task 3 + Task 4), §4.3 non-canonical raw (Task 3), §4.4 fallback-only-for-3 (Task 3), §4.5 no auth change (Task 4 leaves it), §4.7 mapping warning (Task 3), §4.8 input guards (Task 2 max(50)), §6 Option A (Task 1), §7 decrypted-state (Task 4 uses `snapshot.item_state` = mergedState), §11 tests (Tasks 1–4), §13 profile-first (Task 3 "profile wins"). ✓
- No placeholder steps except Task 4 Step 1/3 test authoring, which depends on the existing route test harness — the implementer must model it on the repo's existing `participant_decrypt` test (unit vs integration) rather than a guessed harness.
