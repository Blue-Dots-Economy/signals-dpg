---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Rule: TypeScript Style

Applies to every TypeScript file in the repo — `apps/api`, `apps/ui` and `packages/*`.

## Type safety

- `strict` is on. Do not weaken it in an app or package `tsconfig.json`.
- `noUncheckedIndexedAccess` is **not** on yet. Until it is, treat an indexed read (`arr[0]`, `record[key]`) as possibly `undefined` and check it — do not rely on the compiler to catch it.
- No `any`. Use `unknown` plus narrowing for anything crossing a boundary: `catch (e)`, inter-instance responses, parsed JSON, `network.json` content.
- No `as` casts. A cast is an unchecked assertion. Validate with Zod — the API already runs `fastify-type-provider-zod`, so a route's input and output shapes come from a schema, not a cast.
- Use `===`, never `==`.

```ts
// ✅
const parsed = ItemSchema.safeParse(payload);
if (!parsed.success) return reply.code(400).send({ error: "INVALID_ITEM_STATE" });

// ❌
const item = payload as Item;
```

## Type design

- Plain data — DTOs, config shapes, props — is an `interface` or `type`, not a class.
- Prefer string-literal unions over `enum`: `type Lifecycle = "draft" | "live" | "paused" | "retired"`.
- Derive types with `Pick`, `Omit`, `Partial`, `ReturnType` instead of restating fields. Drizzle inferred types from `packages/database` are the source of truth for table shapes.
- Model states as a discriminated union, not several optional fields that can contradict each other.

## Async

- `async`/`await`, not `.then()` chains.
- Every rejection is handled. An unhandled rejection can take down the Fastify process.
- Independent calls run in parallel with `Promise.all`, or `Promise.allSettled` when partial results are usable.
- Write `ids.map(id => getItem(id))`, not `ids.map(getItem)` — `map` passes the index and the array as extra arguments.

## Modules and immutability

- Named exports.
- Cross-package imports go through the `@dpg/*` alias, never a deep relative path out of the workspace.
- Never mutate an object or array that React renders from. Copy with spread, `map`, `filter`.
