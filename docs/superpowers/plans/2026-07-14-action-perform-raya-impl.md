# `action/perform` Raya-compat (single-object body + `/bulk` route) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `POST /api/v1/action/perform` accept a **single JSON object** (so Raya/Litwiz voice tools can call it), and move the batch-array capability to a new `POST /api/v1/action/perform/bulk` — batch engine, per-item schema, consent gating, and peer-forward all unchanged.

**Architecture:** Extract the existing array handler body into one shared `runPerformActions(items, request, reply)`. Register two routes that both call it: `/perform/bulk` passes the array body verbatim; `/perform` validates a single object and passes `[body]`. Response envelope (`{results, summary}`) is identical on both. Cut over all first-party signals-dpg callers (UI, tests, Postman) in the same change, since `/perform` becomes single-object-only (a lingering array → 400).

**Tech Stack:** Fastify + Zod (`fastify-type-provider-zod`), Vitest; React UI (`action-api.ts`).

**Spec:** `docs/superpowers/specs/2026-07-14-action-perform-raya-design.md` (issue #293; blocks #160). Branch: `spec/action-perform-raya-compat` (this worktree). Other repos (ai-diffusion `action_gateway.yaml`) are **out of scope** for now (separate follow-on).

## Global Constraints

- **Branch:** `spec/action-perform-raya-compat` only (isolated worktree). Do NOT touch `feature`/`develop` or the caching branch.
- **ESM, strict TS, no `any`; routes never throw** (return `reply.code(N).send(...)`). Handler-fn exports snake_case, internal camelCase; Zod schemas PascalCase.
- **Do NOT change** the batch engine (`bulk_runner`), the per-item schema (`PerformActionBodySchema`), consent gating, or the peer route `POST /api/v1/network/action/perform` (used by match-engine — untouched).
- **`/perform` single route:** body = `PerformActionBodySchema` (object); handler wraps `[body]`; reachable response codes are **201** (ok) and **422** (per-item validation/precondition fail). 207/400 are unreachable for a single validated object — do not declare them on `/perform`.
- **`/perform/bulk`:** body + all responses **verbatim** today's `/perform` (array; 201/207/422 + 400 `BULK_EMPTY_ARRAY`/`BULK_LIMIT_EXCEEDED`).
- **Response shape unchanged** on both routes: the `BulkPerformActionResponseSchema` envelope. `/perform` returns `summary.total === 1`.

## File Structure

- `apps/api/src/routes/v1/action/perform_action.ts` — **modify**: extract shared core; register two routes.
- `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts` — **modify**: repoint array cases to `/perform/bulk`; add single-object cases on `/perform`.
- `apps/api/src/routes/v1/action/__tests__/consent_flow.integration.test.ts` — **modify**: single-action posts `[obj]`→`obj` on `/perform`.
- `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts` — **modify**: same.
- `apps/api/src/routes/v1/action/__tests__/get_action_contact_details.integration.test.ts` — **modify**: same.
- `apps/ui/src/lib/action-api.ts` — **modify**: `performAction` single object; `performActionsBulk` → `/perform/bulk`.
- `docs/postman/Signals-DPG.postman_collection.json` — **modify**: `/action/perform` bodies array→object.
- `examples/postman/dpg.postman_collection.json`, `examples/schemas/{blue_dot,yellow_dot,inter-network-action}/postman/*.json` — **modify**: same (per "all places").

---

### Task 1: Split the route (`perform_action.ts`)

**Files:** Modify `apps/api/src/routes/v1/action/perform_action.ts`.

**Interfaces:**
- Produces: `POST /api/v1/action/perform` (body `PerformActionBodySchema`, single object) and `POST /api/v1/action/perform/bulk` (body `BulkPerformActionBodySchema = z.array(z.unknown())`). Both return `BulkPerformActionResponseSchema`.

- [ ] **Step 1: Extract the shared core**

The current file has `const BulkPerformActionBodySchema = z.array(z.unknown());`, then the plugin `perform_action` registering one `/perform` route, then `perform_action_handler(request: FastifyRequest<{ Body: unknown[] }>, reply)` whose body is `const sourceInstanceUrl = getCurrentApiBaseUrl(); const outcome = await runBulk(request.body, async (raw, index) => { …all per-item logic… }); …reply send…`.

Rename `perform_action_handler` to an internal core that takes the items array explicitly. Replace its signature and the single `request.body` read:

```ts
// was: const perform_action_handler = async (request: FastifyRequest<{ Body: unknown[] }>, reply) => {
//        const sourceInstanceUrl = ...; const outcome = await runBulk(request.body, ...); ... }
async function runPerformActions(
  items: unknown[],
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const sourceInstanceUrl = getCurrentApiBaseUrl();
  const outcome = await runBulk(items, async (raw, index) => {
    // …EXISTING per-item body verbatim (unchanged)…
  });
  // …EXISTING reply-send tail verbatim (unchanged)…
}
```

Keep the entire per-item closure and the reply-send tail **byte-for-byte**; the only change is `request.body` → `items` in the `runBulk(...)` call.

- [ ] **Step 2: Register both routes in the plugin**

Replace the single `fastify.route({ url: '/perform', … })` registration with two:

```ts
export const perform_action: FastifyPluginAsyncZod = async function (fastify) {
  // Single-object body — Raya/Litwiz voice tools can only send a JSON object (#293).
  fastify.route({
    url: '/perform',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: PerformActionBodySchema,
      response: {
        201: BulkPerformActionResponseSchema,
        422: BulkPerformActionResponseSchema,
      },
    },
    handler: (request, reply) =>
      runPerformActions([request.body], request, reply),
  });

  // Array body — genuine batch (today's behavior verbatim).
  fastify.route({
    url: '/perform/bulk',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: BulkPerformActionBodySchema,
      response: {
        201: BulkPerformActionResponseSchema,
        207: BulkPerformActionResponseSchema,
        422: BulkPerformActionResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: (request, reply) =>
      runPerformActions(request.body as unknown[], request, reply),
  });
};
```

`action_routes.ts` needs **no change** (it registers the `perform_action` plugin, which now registers both routes).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: clean. (If `request.body` on the single route is typed via the Zod schema, `[request.body]` is `unknown[]`-compatible for `runPerformActions`.)

- [ ] **Step 4: Commit** (after Task 3's tests are green — commit route + tests together; or commit route now and tests next. Prefer: commit at end of Task 3.)

---

### Task 2: UI cutover (`apps/ui/src/lib/action-api.ts`)

**Files:** Modify `apps/ui/src/lib/action-api.ts` (lines ~97 doc, ~269 `performAction`, ~299 `performActionsBulk`).

**Interfaces:** `performAction(payload, sourceInstanceUrl?)` and `performActionsBulk(payloads, sourceInstanceUrl?)` keep their signatures — only the wire call changes. Callers (`home-page.tsx`) are unaffected.

- [ ] **Step 1: `performAction` → single object on `/perform`**

Change the body from `[payload]` to `payload`:
```ts
return unwrapBulkSingle(
  client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', payload),
);
```
(`unwrapBulkSingle` still receives the same `{results, summary}` envelope — response handling unchanged.)

- [ ] **Step 2: `performActionsBulk` → `/perform/bulk`**

Change the URL only (body stays the `payloads` array):
```ts
return postBulkEnvelope<PerformActionResponse>(
  client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform/bulk', payloads),
);
```

- [ ] **Step 3: Fix the doc comment** near line 97 if it describes `/action/perform` as taking an array — update to "single object; bulk variant is `/action/perform/bulk`".

- [ ] **Step 4: Typecheck + UI tests**

Run: `pnpm --filter ui exec tsc --noEmit` then `pnpm --filter ui test`
Expected: clean + green (no UI test asserts the request body array-ness; if one does, update it to the single-object shape).

- [ ] **Step 5: Commit**
```bash
git add apps/ui/src/lib/action-api.ts
git commit -m "feat(ui): action/perform sends single object; bulk uses /perform/bulk (#293)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: API tests (`perform_action.test.ts` + 3 integration tests)

**Files:** Modify the four test files listed in File Structure.

- [ ] **Step 1: `perform_action.test.ts` — repoint array cases to `/perform/bulk`**

Every existing case that does `app.inject({ method:'POST', url:'/api/v1/action/perform', payload: [ … ] })` posts an **array**. Change those `url` values to `'/api/v1/action/perform/bulk'` (leave the array payloads + assertions as-is — they're the bulk behavior, now on the bulk route).

- [ ] **Step 2: `perform_action.test.ts` — add single-object cases on `/perform`**

Add a `describe('POST /api/v1/action/perform — single object', …)` with (reuse the file's existing `app` harness, `VALID_BODY`, and fetch mock):
```ts
it('201 with a single-object body → { results:[one], summary:{ total:1 } }', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/action/perform',
    headers: { 'x-api-key': /* the file's valid key */ , 'content-type': 'application/json' },
    payload: VALID_BODY, // NOTE: object, not [VALID_BODY]
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.summary.total).toBe(1);
  expect(body.results).toHaveLength(1);
});

it('422 when the single object fails per-item validation', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/action/perform',
    headers: { 'x-api-key': /* valid key */, 'content-type': 'application/json' },
    payload: { action_type: 'connect' }, // missing source_item/target_item
  });
  expect(res.statusCode).toBe(422);
});
```
Match the exact header/key setup and `VALID_BODY` the file already uses (read the top of the file). Confirm the single-object 201 assertion matches the real envelope field names (`summary.total`, `results`).

- [ ] **Step 3: Integration tests — single-action posts `[obj]` → `obj`**

In `consent_flow.integration.test.ts` (3 sites), `on_behalf_of.integration.test.ts` (4 sites), `get_action_contact_details.integration.test.ts` (1 site): each `app.inject({ url:'/api/v1/action/perform', payload:[ {…} ] })` is a **single-action** flow — change `payload: [ {…} ]` to `payload: {…}` (unwrap the single element). Assertions on `results[0]` / `summary` stay valid (`total:1`). Do NOT change any post to `/api/v1/network/action/perform` (peer route).

- [ ] **Step 4: Run the unit test (integration needs db+redis — note if unavailable)**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts`
Expected: PASS (bulk cases on `/perform/bulk`, new single cases on `/perform`).
Run the full non-integration action suite: `pnpm --filter api exec vitest run src/routes/v1/action`
Expected: PASS. (Integration `*.integration.test.ts` are skipped without db+redis — state in the report that they were updated but not run locally.)

- [ ] **Step 5: Commit** (route + tests together)
```bash
git add apps/api/src/routes/v1/action/perform_action.ts apps/api/src/routes/v1/action/__tests__/
git commit -m "feat(api): split action/perform into single-object + /perform/bulk (#293)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Postman collections (array → single object on `/perform`)

**Files:** the Postman JSON files in File Structure.

- [ ] **Step 1: Update every `/api/v1/action/perform` request body from a top-level array to a single object**

In each collection, find requests whose `url.raw` ends in `/api/v1/action/perform` (NOT `/network/action/perform`). Their `request.body.raw` is a JSON string of a one-element array `"[\n  {\n …\n  }\n]"`. Change it to just the object `"{\n …\n}"` (drop the outer `[ ]`). Files + counts:
- `docs/postman/Signals-DPG.postman_collection.json` — 3 requests (apply/connect variants).
- `examples/postman/dpg.postman_collection.json` — 1.
- `examples/schemas/blue_dot/postman/blue_dot.postman_collection.json` — 2.
- `examples/schemas/yellow_dot/postman/yellow_dot.postman_collection.json` — 2.
- `examples/schemas/inter-network-action/postman/inter_network_action.postman_collection.json` — 1.

Leave all `/network/action/perform` requests untouched. If any collection has a genuine multi-item batch request, repoint its URL to `/api/v1/action/perform/bulk` instead of de-arraying (none expected — verify).

- [ ] **Step 2: Validate JSON**

Run: `node -e "for (const f of process.argv.slice(1)) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('all valid')" docs/postman/Signals-DPG.postman_collection.json examples/postman/dpg.postman_collection.json examples/schemas/blue_dot/postman/blue_dot.postman_collection.json examples/schemas/yellow_dot/postman/yellow_dot.postman_collection.json examples/schemas/inter-network-action/postman/inter_network_action.postman_collection.json`
Expected: `all valid`.

- [ ] **Step 3: Commit**
```bash
git add docs/postman examples/postman examples/schemas
git commit -m "docs: Postman action/perform requests use single-object body (#293)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** route split (Task 1), UI cutover both callers (Task 2), tests single+bulk (Task 3), Postman (Task 4). Peer route + batch engine + per-item schema + consent untouched (Global Constraints). ai-diffusion explicitly out of scope. All matches the design spec's decision table + cutover list.

**Placeholder scan:** the two "read the file for exact key/VALID_BODY" notes in Task 3 are grounding instructions (the harness/key setup already exists in the file), not vague requirements.

**Type consistency:** `runPerformActions(items: unknown[], request, reply)` consumed by both route handlers; `PerformActionBodySchema` (object) on `/perform`, `BulkPerformActionBodySchema` (array) on `/perform/bulk`; both respond with `BulkPerformActionResponseSchema`.

**Breaking-change check:** `/perform` becomes object-only; all in-repo array senders (UI bulk, tests, Postman) are cut over in this plan. Match-engine (peer route) unaffected. ai-diffusion is the only external array sender — noted as out-of-scope follow-on.
