# Deployment & Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand Signals-DPG up with its own CI, image build, and deploy pipeline now that we own the repo. Establish Drizzle as the single source of truth for schema. Land the helm-chart updates that Plan 2 (`user` attribution columns) and Plan 3 (`signal-processor` worker + `participant_metrics` table) require.

**Architecture:**
- **Schema source of truth:** Drizzle. A generator script renders `helmcharts/dpg/charts/api/files/schema.sql` from current Drizzle migrations on every PR. CI fails if the bundled SQL is stale.
- **CI:** one GitHub Actions workflow (`.github/workflows/ci.yaml`) running on PRs and pushes to `develop` — install / typecheck / vitest / dep-cruise / helm lint / schema-bundle freshness check.
- **CD:** workflow that on merge to `develop` builds images for `api`, `ui`, `signal-processor`, `match-score`, `notification-service` and pushes to our own GHCR namespace; on a semver tag also tags with the version.
- **Helm:** umbrella chart from PR #3 gets a new sub-chart for `signal-processor`; `api/values.yaml`, `ui/values.yaml`, etc. switch `image.repository` from the vendor's `ghcr.io/sanketika-obsrv/...` to our own.
- **Migrate-job:** keeps the `psql + idempotent schema.sql` pattern for now (covers Plans 2 + 3, which are additive-only). Migration runner upgrade is deferred behind a contract written into the plan but not implemented yet.

**Tech Stack:** GitHub Actions, Drizzle (`drizzle-kit`), `pnpm`, `helm` 3.x, `kubectl`, Docker buildx, GHCR.

**Prereqs:**
- PR #3 (helmcharts) retargeted to `develop` and merged.
- Cross-cutting cherry-pick PR (auth middleware unification, item delete, cache invalidation, etc.) merged. Plan 1 builds on that auth middleware.
- Plan 1 doesn't have to be merged for this plan to start — Workstreams A (schema), B (CI), and C (images) are independent. Workstream D (signal-processor sub-chart) only lands meaningfully once Plan 3's worker exists.

**Out of scope:**
- ArgoCD / Flux / any GitOps controller selection. This plan lands a working `helm upgrade` from CI; a GitOps wrapper on top is a follow-up.
- Observability stack (Grafana / Loki / Tempo / Prometheus). Mentioned in Workstream H as a follow-up but not implemented here.
- Multi-cluster / multi-region. Single deploy target per environment.

---

## File Structure

| File | Workstream | Responsibility |
|---|---|---|
| `scripts/generate-schema-bundle.mjs` (new) | A | Reads Drizzle migrations + `packages/database/src/utils/sql_scripts/*.sql`, produces `helmcharts/dpg/charts/api/files/schema.sql` |
| `scripts/__tests__/generate-schema-bundle.test.mjs` (new) | A | Tests the generator |
| `helmcharts/dpg/charts/api/files/schema.sql` (regenerated) | A | Bundled idempotent schema for the migrate-job |
| `.github/workflows/ci.yaml` (new) | B | PR + push-to-develop checks |
| `.github/workflows/build-images.yaml` (new) | C | Builds and pushes images on merge / tag |
| `apps/signal-processor/Dockerfile` (lives in Plan 3, referenced here) | C | Built by build-images.yaml |
| `helmcharts/dpg/charts/signal-processor/` (new tree) | D | Sub-chart for Plan 3's worker |
| `helmcharts/dpg/Chart.yaml` (modify) | D | Add signal-processor as a dependency |
| `helmcharts/dpg/values.yaml` (modify) | D | Defaults for signal-processor |
| `helmcharts/dpg/values-aws.yaml` (modify) | D | AWS overrides for signal-processor |
| `helmcharts/dpg/charts/api/values.yaml` (modify) | C | image.repository → our GHCR namespace |
| `helmcharts/dpg/charts/ui/values.yaml` (modify) | C | same |
| `helmcharts/dpg/charts/match-score/values.yaml` (modify) | C | same |
| `helmcharts/dpg/charts/notification-service/values.yaml` (modify) | C | same |
| `docs/operations/secrets.md` (new) | F | How secrets are sourced per environment |
| `docs/operations/migrations.md` (new) | G | Migration contract (idempotent SQL today, drizzle-kit migrate later) |

---

## Workstream A — Drizzle as schema source of truth

### Task A.1: Generator script

**Files:**
- Create: `scripts/generate-schema-bundle.mjs`

- [ ] **Step 1: Implement**

```js
// scripts/generate-schema-bundle.mjs
//
// Reads the Drizzle migration journal + meta snapshots and the idempotent
// scripts under packages/database/src/utils/sql_scripts/, and emits the
// bundle the migrate-job applies.
//
// We do NOT translate Drizzle migrations 1:1 into the bundle (those are
// imperative ALTERs that fail on second run). We use Drizzle's *meta*
// snapshot (the final desired state) to render idempotent
// CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX
// IF NOT EXISTS statements, the same shape `create_items.sql` already uses.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const drizzle_dir = join(root, 'apps/api/drizzle');
const idempotent_scripts_dir = join(root, 'packages/database/src/utils/sql_scripts');
const out_path = join(root, 'helmcharts/dpg/charts/api/files/schema.sql');

const BANNER = `-- GENERATED FILE — do not edit by hand.
-- Source: drizzle meta snapshots + packages/database/src/utils/sql_scripts/.
-- Regenerate with: pnpm schema:bundle
--
-- This file is consumed by the helm migrate-job (postgres:16-alpine + psql).
-- Every statement MUST be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
`;

const read_snapshot = async () => {
  const meta_dir = join(drizzle_dir, 'meta');
  const journal = JSON.parse(await readFile(join(meta_dir, '_journal.json'), 'utf8'));
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error('no drizzle migrations found — run pnpm db:generate:api first');
  const snap = JSON.parse(await readFile(join(meta_dir, `${latest.tag}.snapshot.json`), 'utf8'));
  return snap;
};

const render_table = (table) => {
  // Render CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS for each
  // column. Drizzle's snapshot has the column list — read it and emit.
  // (Implementation: walk table.columns, table.indexes, table.compositePrimaryKeys.)
  // …
};

const render_from_snapshot = (snap) => {
  return Object.values(snap.tables).map(render_table).join('\n\n');
};

const append_idempotent_scripts = async () => {
  const files = (await readdir(idempotent_scripts_dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const parts = [];
  for (const f of files) {
    parts.push(`-- from ${f}`);
    parts.push(await readFile(join(idempotent_scripts_dir, f), 'utf8'));
  }
  return parts.join('\n');
};

const main = async () => {
  const snap = await read_snapshot();
  const auth_block = render_from_snapshot(snap); // auth, organization, etc.
  const items_block = await append_idempotent_scripts(); // items + indexes
  const bundle = [BANNER, auth_block, items_block].join('\n\n');
  await writeFile(out_path, bundle, 'utf8');
  console.log(`wrote ${out_path} (${bundle.length} bytes)`);
};

main().catch((err) => { console.error(err); process.exit(1); });
```

Pragmatic note: the `render_table` walk is non-trivial. There are two acceptable shortcuts on day one:
1. **Hand-write `auth.sql`** alongside `create_items.sql` (idempotent CREATE TABLE IF NOT EXISTS for `user`, `account`, `verification`, `organization`, `member`, `invitation`, `team`, `team_member`, `apikey`). The generator just concatenates `*.sql` files in the `sql_scripts` dir. The Drizzle snapshot becomes the source for Drizzle-managed types; the SQL files become the source for the deploy bundle. CI verifies they match by spinning up a Postgres, applying the SQL bundle to one DB, applying Drizzle migrations to a second, and `pg_dump`-comparing schemas.
2. **Use `drizzle-kit drop --custom` or the introspection output** — Drizzle Kit can emit a single CREATE script. Then transform it (regex) to idempotent form.

Option 1 (two parallel sources + CI parity check) is more boring and more correct. Recommended.

- [ ] **Step 2: Add `pnpm schema:bundle` script**

In repo-root `package.json`:
```json
"schema:bundle": "node scripts/generate-schema-bundle.mjs",
"schema:bundle:check": "node scripts/generate-schema-bundle.mjs && git diff --exit-code helmcharts/dpg/charts/api/files/schema.sql"
```

- [ ] **Step 3: Commit**

### Task A.2: Hand-write `auth.sql` (the missing half of the bundle)

**Files:**
- Create: `packages/database/src/utils/sql_scripts/auth.sql`

- [ ] **Step 1: Write idempotent CREATEs for all better-auth tables**

For each table in `apps/api/db/postgres/schema/auth.ts`, emit:
```sql
CREATE TABLE IF NOT EXISTS "user" (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  …
);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN DEFAULT FALSE;
-- Plan 2 columns — land in the same file once Plan 2 schema PR merges:
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS onboarded_by_org_id TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS onboarded_via       TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS onboarded_source_id TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS onboarded_at        TIMESTAMPTZ;
ALTER TABLE "user" ADD CONSTRAINT IF NOT EXISTS user_onboarded_by_org_fk
  FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);
CREATE INDEX IF NOT EXISTS user_onboarded_by_org_idx ON "user" (onboarded_by_org_id);
…
```

And for Plan 3's `participant_metrics`:
```sql
CREATE TABLE IF NOT EXISTS participant_metrics (
  user_id                  TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  onboarded_by_org_id      TEXT REFERENCES organization(id),
  …
);
CREATE INDEX IF NOT EXISTS participant_metrics_org_status_idx
  ON participant_metrics (onboarded_by_org_id, profile_status);
```

- [ ] **Step 2: Verify against Drizzle** — see Task A.3.

### Task A.3: CI parity check (two-DB diff)

**Files:**
- Modify: `.github/workflows/ci.yaml` (created in Workstream B)

- [ ] **Step 1: Add job**

```yaml
schema-parity:
  runs-on: ubuntu-latest
  services:
    postgres-sql:    { image: postgres:16, env: { POSTGRES_PASSWORD: x }, ports: ['5432:5432'] }
    postgres-drizzle:{ image: postgres:16, env: { POSTGRES_PASSWORD: x }, ports: ['5433:5432'] }
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v3
    - run: pnpm install --frozen-lockfile
    # 1. apply the bundled SQL to DB A
    - run: psql "postgres://postgres:x@localhost:5432/postgres" -f helmcharts/dpg/charts/api/files/schema.sql
    # 2. apply Drizzle migrations to DB B
    - run: pnpm db:migrate:api
      env: { POSTGRES_URL: 'postgres://postgres:x@localhost:5433/postgres' }
    # 3. compare schemas
    - run: |
        pg_dump --schema-only --no-owner --no-privileges \
          "postgres://postgres:x@localhost:5432/postgres" > /tmp/sql.sql
        pg_dump --schema-only --no-owner --no-privileges \
          "postgres://postgres:x@localhost:5433/postgres" > /tmp/drizzle.sql
        diff /tmp/sql.sql /tmp/drizzle.sql
```

Any divergence between the two sources fails CI. This is what keeps the bundle honest.

- [ ] **Step 2: Commit**

---

## Workstream B — CI workflow

> **Pre-task: typecheck orchestration is currently broken at the root.**
> `pnpm tsc --noEmit` (the command `CLAUDE.md` documents as the pre-commit check) executes against the root `tsconfig.json`, which includes every workspace but doesn't carry per-workspace compiler options (`jsx`, per-workspace path aliases, Astro virtual modules). It reports false errors. The correct command today is **per-workspace**:
> - `pnpm --filter api  exec tsc --noEmit`
> - `pnpm --filter ui   exec tsc --noEmit`
> - `pnpm --filter docs exec astro check` (Astro's `astro:content` virtual modules require `astro check`, not `tsc` — `tsc` will always fail on them)
>
> CI (Task B.1) must use these forms. Task B.2 (below) lands the durable fix.

### Task B.1: PR + develop checks

**Files:**
- Create: `.github/workflows/ci.yaml`

- [ ] **Step 1: Write the workflow**

```yaml
name: CI
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  typecheck-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api exec tsc --noEmit

  typecheck-ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ui exec tsc --noEmit

  typecheck-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # `astro check` regenerates the astro:content virtual module types
      # internally; plain `tsc --noEmit` cannot see them.
      - run: pnpm --filter docs exec astro check

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r test

  dep-cruise:
    runs-on: ubuntu-latest
    if: ${{ hashFiles('.dependency-cruiser.cjs') != '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - run: pnpm dep-check || true   # tighten to fail once green

  schema-bundle-fresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - run: pnpm schema:bundle:check

  helm-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - run: helm dependency update helmcharts/dpg
      - run: helm lint helmcharts/dpg
      - run: helm lint helmcharts/dpg -f helmcharts/dpg/values-aws.yaml
      - run: helm template helmcharts/dpg > /dev/null
      - run: helm template helmcharts/dpg -f helmcharts/dpg/values-aws.yaml > /dev/null

  schema-parity:
    # See Workstream A Task A.3
    runs-on: ubuntu-latest
    services:
      postgres-sql:
        image: postgres:16
        env: { POSTGRES_PASSWORD: x }
        ports: ['5432:5432']
        options: --health-cmd "pg_isready" --health-interval 5s --health-retries 10
      postgres-drizzle:
        image: postgres:16
        env: { POSTGRES_PASSWORD: x }
        ports: ['5433:5432']
        options: --health-cmd "pg_isready" --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - run: psql postgres://postgres:x@localhost:5432/postgres -f helmcharts/dpg/charts/api/files/schema.sql
      - run: pnpm db:migrate:api
        env: { POSTGRES_URL: postgres://postgres:x@localhost:5433/postgres }
      - name: diff
        run: |
          pg_dump --schema-only --no-owner --no-privileges postgres://postgres:x@localhost:5432/postgres > /tmp/sql.sql
          pg_dump --schema-only --no-owner --no-privileges postgres://postgres:x@localhost:5433/postgres > /tmp/drizzle.sql
          diff /tmp/sql.sql /tmp/drizzle.sql
```

- [ ] **Step 2: Run on a draft PR to validate**

- [ ] **Step 3: Commit**

### Task B.2: Durable fix for the typecheck contract

**Problem:** the root `tsconfig.json` declares `include: ["apps/**/*", "packages/**/*"]` and extends `tsconfig.base.json`, but per-workspace settings (`jsx`, path aliases, library types) are NOT inherited from each workspace's local `tsconfig.json`. So `pnpm tsc --noEmit` at the root reports false errors. `CLAUDE.md` documents this command as the pre-commit check — it has never actually worked end-to-end.

Two acceptable fixes, in order of preference:

**Option A (recommended): TypeScript project references.**

- Convert the root `tsconfig.json` from `include`-based to references-based:
  ```jsonc
  // tsconfig.json
  {
    "files": [],
    "references": [
      { "path": "apps/api" },
      { "path": "apps/ui" },
      { "path": "apps/docs" },
      { "path": "packages/auth" },
      { "path": "packages/config" },
      { "path": "packages/database" },
      { "path": "packages/match_score" },
      { "path": "packages/notification" },
      { "path": "packages/schemas" }
    ]
  }
  ```
- Each workspace `tsconfig.json` must set `composite: true` (most already do via `tsconfig.base.json`).
- `tsc -b` at the root then orchestrates per-workspace builds and respects each workspace's compiler options.
- For Astro: `apps/docs` is excluded from the `tsc -b` references and gets its own job (`astro check`) in CI. Project references do not handle Astro's virtual modules.

**Option B (simpler, less durable): add a root `typecheck` script that fans out per workspace.**

- In root `package.json`:
  ```json
  "scripts": {
    "typecheck": "pnpm --filter api exec tsc --noEmit && pnpm --filter ui exec tsc --noEmit && pnpm --filter docs exec astro check"
  }
  ```
- Document `pnpm typecheck` instead of `pnpm tsc --noEmit` in `CLAUDE.md`.
- Faster to land; doesn't unlock incremental builds the way project references do.

**Files:**
- Modify: `tsconfig.json` (root)
- Modify: `package.json` (root) — `typecheck` script
- Modify: `CLAUDE.md` — replace `pnpm tsc --noEmit` with `pnpm typecheck` (and/or per-workspace forms)
- Possibly modify: `apps/docs/package.json` — add a `typecheck` script wrapping `astro check`

**Steps:**

- [ ] **Step 1: Choose Option A or Option B**
  Surface to user. Default = Option A; Option B if the team wants to defer the project-references investment.

- [ ] **Step 2: Implement chosen option** (one of the file lists above).

- [ ] **Step 3: Verify**
  ```bash
  # Option A
  tsc -b --dry --verbose            # confirms graph
  pnpm typecheck                    # runs the actual build

  # Option B
  pnpm typecheck                    # fans out per-workspace
  ```
  Both should exit 0 on a clean tree.

- [ ] **Step 4: Update CLAUDE.md**
  Replace any reference to a root-level `pnpm tsc --noEmit` with the working command.

- [ ] **Step 5: Tighten CI (Task B.1)**
  Once `pnpm typecheck` works at the root, the three separate `typecheck-{api,ui,docs}` jobs can collapse into one. Keep them separate until then so a failure in one doesn't mask the others.

- [ ] **Step 6: Commit**
  Single commit, low blast radius. Lands independently of any other workstream.

---

## Workstream C — Image build & registry

### Task C.1: Pick the registry namespace

- [ ] **Step 1: Decision**

Default: `ghcr.io/blue-dots-economy/signals-dpg/<service>`. GHCR is free for public repos; for private repos billed minimally; tightly tied to GitHub identity which simplifies auth.

Surface to user before writing the workflow. If they pick ECR or another registry, swap the login + tag steps below.

### Task C.2: Build & push workflow

**Files:**
- Create: `.github/workflows/build-images.yaml`

- [ ] **Step 1: Write the workflow**

```yaml
name: build-images
on:
  push:
    branches: [develop, main]
    tags: ['v*.*.*']
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service:
          - { name: api,                  context: ., dockerfile: apps/api/Dockerfile }
          - { name: ui,                   context: ., dockerfile: apps/ui/Dockerfile }
          - { name: signal-processor,     context: ., dockerfile: apps/signal-processor/Dockerfile }
          - { name: match-score,          context: ., dockerfile: packages/match_score/Dockerfile }
          - { name: notification-service, context: ., dockerfile: packages/notification/Dockerfile }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/blue-dots-economy/signals-dpg/${{ matrix.service.name }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha,format=short
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.service.context }}
          file: ${{ matrix.service.dockerfile }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=${{ matrix.service.name }}
          cache-to: type=gha,mode=max,scope=${{ matrix.service.name }}
```

- [ ] **Step 2: Confirm each Dockerfile exists**

`apps/api/Dockerfile`, `apps/ui/Dockerfile` (from cross-cutting PR), `apps/signal-processor/Dockerfile` (Plan 3). For services that don't yet have a Dockerfile, mark the matrix entry as `if: false` in the workflow until the Dockerfile lands.

- [ ] **Step 3: Commit**

### Task C.3: Point helm at our registry

**Files:**
- Modify: `helmcharts/dpg/charts/{api,ui,match-score,notification-service}/values.yaml`

- [ ] **Step 1: For each sub-chart, change `image.repository`:**
```yaml
image:
  repository: ghcr.io/blue-dots-economy/signals-dpg/api  # was: ghcr.io/sanketika-obsrv/dpg-monorepo/api
  tag: ""
  pullPolicy: IfNotPresent
```

- [ ] **Step 2: Commit**

---

## Workstream D — `signal-processor` sub-chart

### Task D.1: Scaffold the sub-chart

**Files:**
- Create: `helmcharts/dpg/charts/signal-processor/` tree

- [ ] **Step 1: Generate scaffold**
```bash
cd helmcharts/dpg/charts
helm create signal-processor
# delete the generated ingress.yaml, service.yaml, serviceaccount.yaml ingress chunks —
# the worker has no HTTP surface.
```

- [ ] **Step 2: Trim templates**

Keep:
- `templates/deployment.yaml`
- `templates/configmap.yaml`
- `templates/_helpers.tpl`
- `Chart.yaml`
- `values.yaml`

Delete:
- `templates/service.yaml`
- `templates/ingress.yaml`
- `templates/hpa.yaml` (worker is singleton; scaling is wrong without sharding)
- `templates/tests/` (no smoke test endpoint to hit)

- [ ] **Step 3: Configure**

`Chart.yaml`:
```yaml
apiVersion: v2
name: signal-processor
description: "Signals DPG — schedule-driven metrics worker"
type: application
version: 0.1.0
appVersion: "0.1.0"
```

`values.yaml`:
```yaml
replicaCount: 1   # singleton; scheduler is in-process

image:
  repository: ghcr.io/blue-dots-economy/signals-dpg/signal-processor
  tag: ""
  pullPolicy: IfNotPresent

env:
  NODE_ENV: production
  LOG_LEVEL: info
  # POSTGRES_URL / REDIS_URL come from the umbrella secret

resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits:   { cpu: 500m, memory: 512Mi }

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }

# explicitly NO service block — this is a worker.
```

`templates/deployment.yaml` is a standard Deployment with `replicas: {{ .Values.replicaCount }}`, one container, envFrom: configmap + secret (mirroring the api sub-chart). No probes (the cron schedule is the heartbeat); add a `livenessProbe` later that touches a tiny health file the scheduler writes once per tick.

- [ ] **Step 4: Add as dependency in the umbrella**

`helmcharts/dpg/Chart.yaml`:
```yaml
dependencies:
  - name: signal-processor
    version: 0.1.0
    condition: signal-processor.enabled
```

`helmcharts/dpg/values.yaml`:
```yaml
signal-processor:
  enabled: true
```

- [ ] **Step 5: Lint + commit**
```bash
helm dependency update helmcharts/dpg
helm lint helmcharts/dpg
helm template helmcharts/dpg | grep -A2 "kind: Deployment" | grep signal-processor   # sanity
```

---

## Workstream E — Schema deltas for Plans 2 and 3

This is a sequencing workstream, not new artefacts. When Plan 2 or 3 merges:

- [ ] **Step 1**: Plan 2 introduces 4 columns on `user` + FK + index. Drizzle migration is generated by `pnpm db:generate:api`. `packages/database/src/utils/sql_scripts/auth.sql` (Workstream A.2) gets matching `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements in the same PR.

- [ ] **Step 2**: Plan 3 introduces `participant_metrics`. Same pattern: Drizzle migration + idempotent SQL block in `auth.sql` (or a new `metrics.sql`).

- [ ] **Step 3**: CI's `schema-parity` job (A.3) catches it if anyone forgets.

---

## Workstream F — Secrets

### Task F.1: Document the contract

**Files:**
- Create: `docs/operations/secrets.md`

- [ ] **Step 1: Write**

Contents:
- **Local dev:** plaintext `.env` at repo root, loaded by `scripts/turbo-with-root-env.mjs`. Never committed (already in `.gitignore`).
- **In-cluster default values (`values.yaml`):** plain Kubernetes secrets created out-of-band with `kubectl create secret generic dpg-secrets --from-literal=…`. Helm references them by name.
- **AWS values (`values-aws.yaml`):** External Secrets Operator. Each secret in the chart resolves to an `ExternalSecret` that points at a `SecretStore` backed by AWS Secrets Manager.

ESO bootstrap is **out of scope for this repo** — it's a platform-team install (cluster-wide). Document the required SecretStore name and the secret keys this chart consumes.

- [ ] **Step 2: List the required secret keys**

For api: `POSTGRES_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY` (if used), apikey signing secret, etc.

For signal-processor: `POSTGRES_URL` only.

Producing a single canonical list lets the platform team pre-create the keys.

---

## Workstream G — Migrate-job evolution contract

### Task G.1: Document today's contract

**Files:**
- Create: `docs/operations/migrations.md`

- [ ] **Step 1: Write**

> **Today (Plans 1–3 era):** migrate-job runs `psql -f /etc/dpg/schema.sql` against the database. `schema.sql` is generated from Drizzle migrations + idempotent SQL files by `pnpm schema:bundle` (Workstream A). Every statement must be of the form `CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ALTER … ADD CONSTRAINT IF NOT EXISTS`. This handles additive changes only.
>
> **Tomorrow:** the moment we need a non-additive change (drop a column, change a type, add NOT NULL on existing data, rename), this contract breaks. Switch the migrate-job to a real migration runner:
>
> - Replace the `postgres:16-alpine` container with a `node:24-alpine` container that has the API's `node_modules/drizzle-kit` available.
> - Replace the command `psql -f …` with `pnpm db:migrate:api` (which runs `drizzle-kit migrate`).
> - Drop the embedded `schema.sql` configmap; Drizzle's migration journal in the image is sufficient.
>
> Don't switch preemptively — keep the idempotent SQL bundle until a non-additive change is actually needed.

- [ ] **Step 2: Commit**

---

## Workstream H — Observability (deferred; documented)

Not implemented in this plan. Captured so it's not forgotten:

- **Logging:** pino → stdout → cluster log collector (Loki / CloudWatch / etc.) — depends on the platform team's stack.
- **Metrics:** add `prom-client` to the api and signal-processor; expose `/metrics`; let Prometheus scrape via a `ServiceMonitor` CRD if the cluster runs Prometheus Operator.
- **Tracing:** OpenTelemetry SDK in api; the signal-processor passes can emit a single span per run.

Open a tracking issue once Plans 1–3 are deployed; size the work then.

---

## Self-Review Checklist

- Workstream A produces a single source of truth (Drizzle) with a parity check that fails CI on drift. ✅
- Workstream B covers typecheck, test, dep-cruise, helm-lint, schema-parity. Missing: vitest needs to exist for `apps/api` (added in Plan 1 Task 1). ✅ — dependency noted in Prereqs.
- Workstream C ships images for every service the umbrella chart references. Matrix gate (`if: false`) covers services whose Dockerfile lags. ✅
- Workstream D's sub-chart for signal-processor matches Plan 3 Task 12's Dockerfile path (`apps/signal-processor/Dockerfile`). ✅
- Workstream E captures the sequencing dependency between this plan and Plans 2/3. ✅
- Workstream F documents (not implements) ESO. Acceptable for MVP; platform team owns the cluster-wide install. ✅
- Workstream G locks in the migrate-job contract and the upgrade path. ✅

## Open Questions

1. **Registry choice** (Workstream C Task C.1) — surface to user. Default = GHCR under `blue-dots-economy`. **Resolved during execution:** GHCR `ghcr.io/blue-dots-economy/signals-dpg/<service>`.
2. **Pre-merge smoke test** — do we want a "deploy to ephemeral cluster, hit `/health/ready`, tear down" stage in CD? Useful but slow; add once the basic pipeline is stable.
3. **Drizzle journal format compatibility** — the generator in Task A.1 reads `apps/api/drizzle/meta/_journal.json`. Confirm with the existing Drizzle version in use; Drizzle Kit has changed the snapshot format between major versions. **Resolved by execution:** A.1 took the simpler concatenation path (3 hand-curated SQL files) instead of reading Drizzle's meta — journal format is no longer a dependency.
4. **Signal-processor singleton enforcement** — if helm later scales replicas to >1 by accident, the cron passes will run twice. Add a Postgres advisory lock around each pass body (cheap, 5 lines) as a belt-and-braces guard.

## Follow-ups discovered during execution

These came out of Plan 4 execution (PR #8). They're real but were intentionally deferred to keep Plan 4 reviewable and to let Plans 1-3 move forward. Pick these up when returning to Plan 4 after Plans 1-3 land.

Listed in rough priority order (most operationally critical first):

### F.1 — Remove the migrate-job's "already migrated" short-circuit ⚠️ critical before Plans 2/3 deploy

`helmcharts/dpg/charts/api/templates/migrate-job.yaml:82-86` runs `SELECT 1 FROM information_schema.tables WHERE table_name='items'` and `exit 0`s if the row exists. Once any cluster has run its first migration, subsequent `schema.sql` changes — including Plans 2 and 3's additive column / table adds — silently no-op on that cluster.

**Fix:** delete the short-circuit (or replace with a per-statement guard that's already inside the SQL itself — every statement in the bundle is `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` / `DO`-block-guarded constraint, so re-applying the whole bundle on every release is safe).

**Also:** `helmcharts/dpg/charts/api/values.yaml:150` has a stale comment claiming the check is on `public."user"` — it actually checks `items`. Fix the comment if the short-circuit stays in any form.

**Sequencing:** must land before Plans 2 / 3 deploy to a cluster that has already booted Signals once. Failing that, those plans' schema additions need manual psql application per cluster — operationally painful, easy to miss.

### F.2 — Fix `helmcharts/dpg/Chart.yaml` declared-deps paths

`Chart.yaml` declares sub-chart dependencies via `file://../<name>` but the sub-charts are vendored at `helmcharts/dpg/charts/<name>`. `helm dependency update helmcharts/dpg` fails as a result. `helm lint` and `helm template` happen to work because the vendored copies are already in place, so this isn't immediately visible — but any clean rebuild of the chart dependency graph (e.g. when someone bumps a sub-chart version) will fail.

**Fix:** change the deps to `file://./charts/<name>` (or whatever the right relative path is from `Chart.yaml`'s location), confirm `helm dependency update` exits 0, commit.

### F.3 — Centralise the `postgres:16-alpine` migrate-job image

`helmcharts/dpg/charts/api/templates/migrate-job.yaml` hard-codes `image: postgres:16-alpine` rather than reading from a values key. If the migrate-job ever needs a different client version (e.g. when we eventually swap to `drizzle-kit migrate` per `docs/operations/migrations.md` forward path), this needs a chart edit instead of a values override.

**Fix:** route the image through `.Values.migrate.image` (or similar) and default it in `values.yaml`. Already partially set up — the values file has a `migrate:` block but it's not wired to the template's image field.

### F.4 — Collapse `typecheck-{api,ui,docs}` CI jobs into one `pnpm typecheck` step

B.2 landed the root `pnpm typecheck` script (fan-out). B.1's CI workflow still runs three separate jobs for visibility during the transition. Once B.2's contract has been stable for a few PRs, collapse them into a single job:

```yaml
typecheck:
  steps: [..., - run: pnpm typecheck]
```

Removes ~20 lines of YAML and saves a couple of runner-minutes per PR. Low priority but clean.

### F.5 — Add real test scripts so the `test` CI job stops being warn-only

The `test` job in `.github/workflows/ci.yaml` is `continue-on-error: true` because every workspace currently ships a placeholder `"test": "echo Error && exit 1"`. **Plan 1 Task 1** introduces Vitest in `apps/api`. Once Plan 1 lands, this job should:

1. Drop the `continue-on-error: true`.
2. Update `pnpm -r test` if any workspace's `test` script needs special invocation.

Same applies as more workspaces gain real tests — currently only `apps/api` has Vitest scaffolded (per Plan 1's spec).

### F.6 — Wire `dep-cruise` once `.dependency-cruiser.cjs` exists

The `dep-cruise` CI job is gated on `hashFiles('.dependency-cruiser.cjs') != ''` and currently silently skips. If/when we decide on a dependency-cruiser config (perhaps to enforce the interface-imports restriction documented in aggregator-dpg's `.claude/rules`), add the `.dependency-cruiser.cjs` to repo root and drop the `if:` guard.

### F.7 — Extend the build-images matrix as Dockerfiles land

`.github/workflows/build-images.yaml`'s matrix today has only `api` and `ui` because they're the only services with Dockerfiles in this repo. As the rest land:

- **`signal-processor`** — Plan 3 Task 12 introduces `apps/signal-processor/Dockerfile`. Add a matrix entry then.
- **`match-score`** — currently a `@dpg/match_score` package, no Dockerfile. If/when it becomes a runnable service (per the helm chart structure, the umbrella expects it to be), it'll need its own Dockerfile.
- **`notification-service`** — same situation as `match-score`.

Plan 4 Workstream D (signal-processor sub-chart) is already deferred to Plan 3; this is its CI counterpart.

### F.8 — Revisit B.2 Option A (TS project references) once the team wants incremental builds

B.2 shipped as Option B (fan-out script). Option A (`tsc -b` with per-workspace project references) was investigated during execution and proved more invasive than the spec assumed: it needs `composite: true` + `outDir` on `apps/api`, exclusion of `apps/ui` (whose `noEmit: true` conflicts with composite), and **fabricated tsconfigs** for the 5 source-only package workspaces (`auth`, `config`, `database`, `match_score`, `notification`).

Worth revisiting when:
- `pnpm typecheck` runtime grows past ~30 seconds AND
- Someone has a half-day to write the 5 missing tsconfigs and fix the cross-workspace type drift that Option A will probably surface (notably the cyclical `@dpg/database` ↔ `@dpg/schemas` import flagged during the investigation).

Until then, Option B is honestly fine for a 9-package monorepo.

### F.9 — Drop `apps/api/drizzle/` from `.gitignore` once `drizzle-kit migrate` becomes the deploy path

Today the generated Drizzle migrations under `apps/api/drizzle/` are gitignored (`.gitignore:10` → `drizzle/`). Acceptable while the deploy path is the idempotent SQL bundle.

The moment we follow the forward path in `docs/operations/migrations.md` and switch the helm migrate-job to `pnpm db:migrate:api` (drizzle-kit migrate), the migrations directory becomes the production-critical artifact and must be tracked. Drop the gitignore entry then, commit the generated migrations as they're produced, and update CI to enforce `pnpm db:generate:api` was run on any schema change.

### F.10 — Observability stack (Workstream H, originally deferred)

Pino → stdout works locally but production needs a log shipper. Same for metrics + tracing. Pick a stack:

- **Logging**: Loki / CloudWatch / Datadog / etc.
- **Metrics**: `prom-client` exposing `/metrics`, scraped by Prometheus (or Datadog agent).
- **Tracing**: OpenTelemetry SDK in `apps/api`; one span per `signal-processor` pass.

Out of scope for Plan 4; in scope for whoever owns operability of deployed instances.

### F.11 — Update plan files Tasks A.1/A.2 to reflect what shipped

The plan's task descriptions for A.1 and A.2 still talk about reading Drizzle's `meta` snapshots (the path NOT taken). Once the team is comfortable with the concatenation approach, update the plan text to match reality — the task spec should describe what we did, not what we considered. Low-priority documentation hygiene.
