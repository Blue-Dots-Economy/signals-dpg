# AGENTS.md

Guidance for AI agents working in the DPG monorepo.

## Repo Structure

```
dpg-monorepo/
├── apps/
│   ├── api/               # Fastify API server
│   └── ui/                # React + Vite schema-driven UI
├── packages/
│   ├── auth/              # better-auth configuration
│   ├── config/            # Zod env schemas & allowed lists
│   ├── database/          # Drizzle ORM setup & utilities
│   ├── match_score/       # Match-scoring provider client (DPG scoring)
│   ├── notification/      # Notification service client
│   └── schemas/           # Shared Zod schemas & schema registry
├── turbo.json             # Turborepo task definitions
├── pnpm-workspace.yaml    # pnpm workspace config
└── tsconfig.base.json     # Shared TypeScript config
```

## Package Manager

**pnpm 11.1.2**. Always use `pnpm` (never npm/yarn). Use `pnpm add <pkg>` inside
an app/package dir, or `pnpm add -w <pkg>` for workspace-wide deps.

## Commands

### From root

| Command                | Description                       |
| ---------------------- | --------------------------------- |
| `pnpm dev:api`         | Start API in watch mode           |
| `pnpm dev:ui`          | Start UI dev server               |
| `pnpm build:api`       | Build API for production          |
| `pnpm build:ui`        | Build UI for production           |
| `pnpm preview:ui`      | Preview UI production build       |
| `pnpm preview:api`     | Preview API production build      |
| `pnpm start:ui`        | Start UI production server        |
| `pnpm db:generate:api` | Generate Drizzle migrations       |
| `pnpm db:migrate:api`  | Apply migrations                  |
| `pnpm db:push:api`     | Push schema to DB (no migrations) |
| `pnpm db:pull:api`     | Pull schema from DB               |
| `pnpm db:studio:api`   | Open Drizzle Studio               |

### From `apps/api` directly

| Command                   | Description         |
| ------------------------- | ------------------- |
| `tsx watch src/server.ts` | Dev (watch mode)    |
| `tsup`                    | Build               |
| `drizzle-kit generate`    | Generate migrations |
| `drizzle-kit migrate`     | Apply migrations    |
| `drizzle-kit push`        | Push schema         |

### Tests

**Vitest**, colocated `__tests__/` folders per directory (the norm — a top-level `apps/api/src/__tests__/` also exists for a handful of cross-cutting integration tests). `*.test.ts` is a unit test; `*.integration.test.ts` requires a running Postgres + Redis (`docker compose up -d db redis`) and is excluded from the default `pnpm --filter api test` run.

```bash
pnpm --filter api test                              # unit tests
pnpm --filter api exec vitest run src/path/to/file.test.ts   # one file
pnpm --filter api test:integration                   # integration (needs db+redis running)
```

### Type Checking

**No ESLint/Prettier/Biome configured.** Before committing, run:

```bash
pnpm typecheck
```

Root `pnpm typecheck` runs `tsc --noEmit` for `apps/api` and `apps/ui` in sequence. The package workspaces (`auth`, `config`, `database`, `match_score`, `notification`, `schemas`) are typechecked transitively via the apps. True TS project references were considered (Plan 4 Task B.2 in `docs/superpowers/plans/`) but require structural changes (fabricated tsconfigs, composite + outDir on apps/api, apps/ui exclusion); deferred.

Manually review code for style consistency per the guidelines below.

## TypeScript Conventions

- **Strict mode is enabled**. Avoid `any`.
- Target: ES2022, Module: ESNext, ModuleResolution: bundler.
- Use `import type` for type-only imports.
- Path alias: `@dpg/*` maps to `packages/*/src`.

```ts
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthRuntimeConfig } from './types';
```

## Naming Conventions

| Entity                    | Convention           | Example                            |
| ------------------------- | -------------------- | ---------------------------------- |
| Files                     | snake_case           | `fetch_items.ts`, `item_routes.ts` |
| Functions/variables       | camelCase            | `createItem`, `fetchItemsHandler`  |
| Route handlers (exported) | snake_case           | `create_item`, `fetch_items`       |
| Handler internals         | camelCase            | `createItemHandler`                |
| Env vars                  | SCREAMING_SNAKE_CASE | `POSTGRES_HOST`, `API_PORT`        |
| Zod schemas               | PascalCase           | `CreateItemBodySchema`             |
| DB tables/columns         | snake_case           | `item_type`, `created_at`          |

## Imports & Exports

### Package structure

- Every package must export from `src/index.ts`.
- Use `exports` field in `package.json` (not `main`):
  ```json
  { "exports": { ".": "./src/index.ts" } }
  ```

### Import ordering (separate groups with blank lines)

1. Node/built-in modules (`import fs from 'node:fs'`)
2. Third-party packages
3. Workspace packages (`@dpg/*`)
4. Relative imports

### Cross-package imports

```ts
import { items } from '@dpg/database';
import z from '@dpg/schemas';
import { allowed_origins } from '@dpg/config';
```

## API Routes (Fastify + Zod)

Routes use `fastify-type-provider-zod` with Zod for validation.

### File layout

```
apps/api/src/routes/v1/item/
├── item_routes.ts    # Registers sub-routes
├── create_item.ts    # Route + handler
├── fetch_items.ts    # Route + handler
└── update_item.ts    # Route + handler
```

### Route pattern

```ts
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const my_route: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/endpoint',
    method: 'POST',
    preHandler: auth_middleware,
    schema: {
      tags: ['resource'],
      body: MyBodySchema,
      response: { 200: MyResponseSchema },
    },
    handler: my_handler,
  });
};
export default my_route;
```

### Error handling

- Return structured errors with `error` (machine-readable code) and `message`.
- Log with `request.log.error({ err, context }, 'message')`.
- Handle known DB errors explicitly (PostgreSQL codes `23505` unique violation,
  `23503` foreign key violation).
- Use `reply.code(N).send({ error, message })` — never throw.

```ts
} catch (err) {
  request.log.error({ err, item_type: body.item_type }, 'Failed to create item');
  return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR', message: 'Failed to create item' });
}
```

## Environment & Config

- All env vars are validated with Zod schemas in
  `packages/config/src/secrets.ts`.
- Load config via `loadEnv()` in `apps/api/src/env.ts`.
- Prefer URL-based connection strings (`POSTGRES_URL`, `REDIS_URL`).
- Copy `.env.example` to `.env` to get started.

## Auth & Database

- Auth configured in `packages/auth/src/config.ts` using `better-auth`.
- Use `auth_middleware` plugin for protected routes. OTP flows use `unifiedOtp`.
- **Integrating DPGs**: aggregator-dpg, voice-dpg, etc. authenticate via service apikeys plus an `x-acting-org-id` header. See [`docs/operations/integrating-dpgs.md`](docs/operations/integrating-dpgs.md).
- Schema files: `apps/api/db/postgres/schema/`. Migrations: `apps/api/drizzle/`.
- Use `drizzle-kit` for migrations. **Never edit migration files manually.**
- Use partition-aware queries for item tables to enable partition pruning.

## General Guidelines

- ESM-only: all packages set `"type": "module"`.
- No `console.log` in library packages; use the app logger via `request.log`.
- Keep exports minimal — only export what is needed externally.
- Graceful shutdown on SIGINT/SIGTERM for server apps.
- No `// TODO` comments — open an issue instead.
- No hardcoded secrets or credentials in code.

## UI Data Caching (React Query)

One QueryClient (`apps/ui/src/lib/query-client.ts`), one key factory
(`apps/ui/src/lib/query-keys.ts`). staleTime tiers: config-like data 5 min
(invalidate on change), browse feeds ~90s (+ `cache_ttl_seconds`), own data 60s
(+ invalidate-on-write), actions via `refetchInterval`. Geocoding uses dedicated
caches (Redis server-side, in-memory session client-side), not React Query.
Never rely on `refetchOnWindowFocus` for freshness.

**Deferred — instance-URL cache-busting (caching-spec §8):** when a
`selectedApiUrl` / instance switcher is added to the UI, switching it must bust
the React Query caches (browse/my-items/markers) and the client schema cache
(`clearSchemaCache`), because `createApiClient` captures `baseURL` at
construction. The `resolvedNetwork(networkId, apiBaseUrl)` key already carries
the API base URL. There is no switcher today, so no busting is wired yet.

**Deferred — active profile id (caching-spec §8):** once relevance ranking
(§9, cross-repo P6) lands, add `activeProfileId` to `browseItems` and `markers`
keys because ranking results differ per profile. Not in keys today; placeholder
is in code comments at `queryKeys.browseItems` and `queryKeys.markers`.
