# Local Setup Guide — signals-dpg (Signals Stack)

A single, self-contained guide for bringing up **signals-dpg alone** — the API,
the UI, and only its own backing dependencies (Postgres + Redis) — on a fresh
machine. Two tracks:

| Track               | You want to…                                                    | Follow            |
| ------------------- | --------------------------------------------------------------- | ----------------- |
| **A — Docker-only** | Just get signals running to explore/demo. One command.          | §1 → §2 → §3      |
| **B — Hybrid dev**  | Write code with hot-reload; run the API/UI from source.         | §1 → §4 (2 steps) |
| **+ search**        | Relevance-ranked discover and match scores, not recency order.  | §7 (opt-in)       |

This tooling (`docker-compose.yml`, `.env.example`, `infra/`) lives **inside the
signals-dpg repo at `signals-dpg/local-setup/`** and builds only this repo — no
sibling repos, no aggregator, no Keycloak. Run everything from **`local-setup/`**
(Track A) or the repo root (Track B).

> **⚠️ Memory guidance.** Track A builds **3 images** (bootstrap tools, API, UI)
> and runs ~5 containers. Adding `--profile search` (§7) pulls two more images and
> wants **3-4 GB more** on top — the embedding server loads a ~2.3 GB model on
> CPU. That is why search is opt-in rather than part of the default bring-up. On a low-memory machine (Docker capped ~4 GB), a first
> `docker compose up --build` can be slow. If it thrashes, either build images
> one at a time or use **Track B** (Docker runs only Postgres + Redis; the Node
> apps run on the host):
>
> ```bash
> # from signals-dpg/local-setup/ — build sequentially, stop on first failure
> for s in signals-bootstrap signals-api signals-ui; do
>   docker compose build "$s" || { echo "FAILED at $s"; break; }
> done
> ```

---

## 1. Prerequisites

| Tool                     | Version                 | Needed for  | Notes                                     |
| ------------------------ | ----------------------- | ----------- | ----------------------------------------- |
| **Docker + Compose**     | recent (v2)             | both tracks | Docker Desktop (macOS/Win) or engine+plugin |
| **Node.js**              | ≥ 24 (22 works for dev) | Track B     | —                                         |
| **pnpm**                 | 11.1.2 (pinned)         | Track B     | `corepack enable pnpm`                    |
| **openssl**              | any                     | secrets     | pre-shipped on macOS/Linux                |
| **`docker login dhi.io`** | —                      | **Track A** | Only for building images. See note below. |

> **Track A needs a registry login.** The api and ui images build `FROM
> dhi.io/...` (Docker Hardened Images), and dhi.io refuses anonymous pulls — so
> `docker compose up -d --build` fails at the first `FROM` without
> `docker login dhi.io` using a Docker Hub account. Track B needs no login: it
> builds no app images. The same applies to `pnpm docker:api`.

No external services are needed: signals uses **better-auth** with a test OTP
(`CREATE_TEST_OTP=true`, codes print to the API logs), so there's no Keycloak,
no SMTP, and no SMS gateway for local dev.

---

## 2. Track A — one-command stack (Docker-only)

### 2.1 Configure

```bash
cd signals-dpg/local-setup     # all Track A commands run from here
cp .env.example .env
```

The `.env` ships working dev defaults. The only value worth changing before a
shared-host run is the PII key (and the passwords):

```dotenv
SIGNALS_PII_KEY=<openssl rand -base64 32>   # must decode to exactly 32 bytes
```

### 2.2 Bring it up

```bash
docker compose up -d --build
docker compose ps            # wait until signals-api is up
```

Startup order is automatic:

```
postgres (pgvector+postgis), redis ─► signals-bootstrap (schema + db:init, runs once)
                                    ─► signals-api ─► signals-ui
```

Follow logs if anything looks stuck:

```bash
docker compose logs -f signals-bootstrap   # schema push + db:init
docker compose logs -f signals-api         # API boot; test OTP codes print here
```

### 2.3 URLs

**👉 Open this in a browser:**

| Open this      | URL                   | What it's for                                        |
| -------------- | --------------------- | ---------------------------------------------------- |
| **Signals UI** | http://localhost:5173 | the Signals Stack UI (must be `:5173` — API CORS)    |

**Everything else** — API + datastores, for debugging / direct access:

| Service     | URL                   | Credentials / notes                          |
| ----------- | --------------------- | -------------------------------------------- |
| Signals API | http://localhost:2742 | `/reference` for Swagger; test OTP in logs   |
| Postgres    | localhost:5432        | `postgres` / `POSTGRES_PASSWORD` from `.env` |
| Redis       | localhost:5555        | password-protected (`REDIS_PASSWORD`)        |
| Search API  | localhost:3100        | only with `--profile search` (§7); `POST /v1/search` needs `x-api-key` |

> The UI **must** stay on `:5173` — the API's CORS allow-list is `3000/5173/2742`
> only.

### 2.4 Smoke test

```
1. http://localhost:5173  → the UI loads (browse is empty until you add data).
2. Sign in with any test identity — the OTP code is printed to the API logs:
   docker compose logs signals-api | grep -i otp
3. Optional demo data — note there is NO shell in the api image (it is a Docker
   Hardened Image), so `exec ... sh -lc` fails. Use exec form, which runs the
   node binary directly and needs no shell:
     docker compose exec --workdir /app signals-api \
       node apps/api/dist/scripts/...
   Or run it through signals-bootstrap, which still has a shell:
     docker compose run --rm signals-bootstrap sh -lc "pnpm --filter api ..."
   In Track B, seed from source on the host instead.
```

> Login uses better-auth with `CREATE_TEST_OTP=true`, so the OTP is written to
> the API container logs rather than sent by SMS/email.

> **Discover results come back in recency order here, not by relevance**, and
> match scores are unavailable — signals-search is not running. That is expected
> for the default stack; see §7 to add it.

---

## 3. Day-to-day commands (Track A)

```bash
docker compose ps                       # status
docker compose logs -f <service>        # tail one service
docker compose stop                     # stop, keep data
docker compose up -d                    # resume
docker compose up -d --build <service>  # rebuild one after code changes
docker compose exec postgres psql -U postgres -d postgresdb   # psql
```

**Reset:**

```bash
docker compose down            # stop + remove containers, keep data
docker compose down -v         # ALSO wipe data volumes (fresh DB on next up)
docker compose up -d --build   # rebuild; re-runs schema + db:init
```

---

## 4. Track B — hybrid dev (hot-reload)

Run **Postgres + Redis in Docker**, and the **API + UI from source** with
`pnpm dev`. Two steps.

Ports: API `:2742`, UI `:5173`, Postgres `:5432`, Redis `:5555`.

### Step 1 — Backing services in Docker

Start only Postgres + Redis from the `local-setup/` compose (this uses the
pgvector+postgis image `db:init` needs — the repo's stock `docker-compose.yaml`
does **not** have those extensions):

```bash
cd signals-dpg/local-setup
cp .env.example .env                 # set SIGNALS_PII_KEY + the two passwords
docker compose up -d postgres redis
docker compose ps                    # wait until both are healthy
```

Note the `POSTGRES_PASSWORD` and `REDIS_PASSWORD` you set here — the host-run
app must use the **same** values in Step 2.

### Step 2 — API + UI from source

```bash
cd ..                # repo root: signals-dpg/
pnpm install
cp .env.example .env  # signals-dpg's own root env template
```

Edit the repo-root `.env` so it points at the Dockerised Postgres/Redis from
Step 1 (host `localhost`; reuse the Step 1 passwords):

```dotenv
API_PORT=2742
CREATE_TEST_OTP=true
AUTH_MIDDLEWARE_ENABLED=true
SERVED_DOMAINS=blue_dot/seeker,blue_dot/provider
NETWORK_CONFIG_SOURCE=local
NETWORK_CONFIG_LOCAL_FILE=../../examples/schemas/blue_dot/network.json

# Postgres (Docker, host port 5432)
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
DATABASE_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<same as local-setup/.env>
POSTGRES_DB=postgresdb

# Redis (Docker, host port 5555, password-protected)
REDIS_HOST=127.0.0.1
REDIS_PORT=5555
REDIS_PASSWORD=<same as local-setup/.env>

# PII key — any base64 32-byte value: openssl rand -base64 32
SIGNALS_PII_KEY=<base64-32-byte-key>

# UI reads these (Vite)
VITE_API_URL=http://localhost:2742
VITE_NETWORK_ID=blue_dot
```

Apply the schema, then run it (two terminals):

```bash
pnpm db:push:api      # apply Drizzle schema (confirm the prompt)
pnpm db:init:api      # extensions + partitioned items/actions/events tables

pnpm dev:api          # API on :2742   (terminal 1) — test OTP codes print here
pnpm dev:ui           # UI  on :5173   (terminal 2)
```

Open **http://localhost:5173**. Editing source in either app hot-reloads it.

> **Login OTP in dev:** with `CREATE_TEST_OTP=true` the code is printed to the
> `pnpm dev:api` terminal — grep it there. Set `AUTH_MIDDLEWARE_ENABLED=false`
> to bypass auth entirely for seed/migration scripts.

**Optional demo data:** `pnpm db:seed:purple_dot:api` (or run a different
network — set `SIGNALS_NETWORK` / `SERVED_DOMAINS` and the matching
`NETWORK_CONFIG_LOCAL_FILE` under `examples/schemas/<network>/network.json`).

---

## 5. Optional — service apikey for an integrating DPG

signals runs fully standalone with just the steps above. If you later put a
downstream service in front of it (one that authenticates with the
`x-api-key` + `x-acting-org-id` service-auth model), mint its service user +
apikey with:

```bash
# Track B (from repo root):
pnpm db:seed:services:api      # prints the apikey on FIRST run only — capture it

# Track A (one-off against the running stack):
docker compose run --rm signals-bootstrap \
  sh -lc "pnpm --filter api db:seed:services"
```

This is **not** required to run signals itself, so the bootstrap step omits it
by default.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `port is already allocated` on `up` | Another process holds a host port (`5432`, `5555`, `2742`, `5173`). Free it, or change the host mapping in `docker-compose.yml` / the `*_PORT` values in `.env`. Host-native Postgres on 5432 is NOT freed by stopping Docker. |
| `signals-bootstrap` fails on `CREATE EXTENSION vector`/`postgis` | The Postgres image lacks the extensions. This compose builds the custom `infra/postgres.Dockerfile` (pgvector + postgis) — make sure you're using **this** stack's `postgres` service, not a stock `postgres:*` container. |
| `signals-bootstrap` fails on `SIGNALS_PII_KEY` | It must be base64 that decodes to exactly 32 bytes: `openssl rand -base64 32`. |
| `signals-api` restarts / "relation does not exist" | `signals-bootstrap` didn't finish. Check `docker compose logs signals-bootstrap`; re-run `docker compose up -d --force-recreate signals-bootstrap signals-api`. |
| UI loads but API calls fail with CORS | The UI must be served on `:5173` — the API allow-list is `3000/5173/2742` only. Don't remap the UI host port. |
| Login OTP never arrives | It's not sent anywhere in dev — it's printed: `docker compose logs signals-api \| grep -i otp` (Track A) or the `pnpm dev:api` terminal (Track B). |
| Track B: API can't connect to Postgres/Redis | The host app's `POSTGRES_*` / `REDIS_*` in the repo-root `.env` must match the passwords + ports in `local-setup/.env` (host `127.0.0.1`, Postgres `5432`, Redis `5555`). |
| First `up --build` is very slow | Normal — three images build from source. Subsequent ups are cached. |

### 6.1 signals-search (`--profile search`)

Every row here is a real failure hit while bringing this up, with the config that
prevents it. All of them present as an opaque runtime error rather than a
setup complaint.

| Symptom | Cause / fix |
| --- | --- |
| UI shows **"Showing basic matches — relevance ranking is temporarily unavailable"** | signals-api cannot reach signals-search: `SIGNALS_SEARCH_URL` / `SIGNALS_SEARCH_API_KEY` missing or the call failed. This is a deliberate soft fallback to the native (non-ranked) path — check `docker compose logs signals-api` for the underlying error. Did you create `.env.search` (§7.3)? |
| `503 MATCH_SCORE_NOT_CONFIGURED` | The **match-score** var set is incomplete. It is a *different* set from discover: `MATCH_SCORE_PROVIDER=signals_search` **and** `SIGNALS_SEARCH_ENDPOINT` **and** `SIGNALS_SEARCH_API_KEY`. Note `SIGNALS_SEARCH_ENDPOINT` and `SIGNALS_SEARCH_URL` are the **same value under different names** — setting only one gives you working discover and a broken match score, or vice versa. |
| `401 UNAUTHORIZED` from `/v1/search` | signals-search validates `x-api-key` against the **`apikey` table in the shared Signals DB** — there is no API-key env var and no separate registry. The key must be a real row that is `enabled`, unexpired, with a non-null `user_id`. Mint one per §7.4 and send the **raw** key (the DB stores only its hash). |
| `404 UNSERVED_DOMAIN` (e.g. "blue_dot/provider not served") | The mounted `network.json` lacks that domain, or its top-level `id` does not equal the `networkId` in the request. Both `seeker` and `provider` must appear under `domains[]`. |
| `403 INTERACTION_NOT_ALLOWED` | An entry in `actions[].interactions` is missing one of the **four** required fields — `from_network`, `from_domain`, `to_network`, `to_domain` — or misspells one. All four are mandatory; a three-field entry silently never matches. |
| `signals-search-worker` exits immediately with `EMBEDDING_DIM=… but item_search.embedding is vector(1024)` | The boot guard. `EMBEDDING_DIM` must equal the **code constant** `ITEM_SEARCH_VECTOR_DIM`, not just the live column. See §7.6 — moving off 1024 is a four-place change, not an env tweak. |
| Worker logs `unexpected embedding dimension 1536, expected 1024` and nothing indexes | The embedding **model** emits a different width than `EMBEDDING_DIM` declares. `EMBEDDING_DIM` only declares what to expect — it does not resize the model. Items never index and search silently degrades to the native path. |
| Postgres error `expected 1024 dimensions, not 1536` | The third, independent guard: pgvector rejecting the insert against the `vector(1024)` column typmod. |
| `tei-embeddings` dies during startup, often without a clear error | Almost always memory. bge-m3 loads a ~2.3 GB ONNX model on CPU and its fp32 warmup at TEI's default `--max-batch-tokens 16384` gets OOM-killed **even with 8 GB available**. This compose already pins `4096`; check Docker Desktop → Resources → Memory has ≥4 GB spare on top of the base stack. `docker inspect tei-embeddings --format '{{.State.OOMKilled}}'` confirms it. |
| `/v1/search` returns 200 but `results` is always empty | Nothing has been indexed. Either the worker is not running (`docker compose --profile search ps`), or the schema's fields are not marked `vectorize: true`, or the sweep has not caught up yet — it runs every `SWEEP_INTERVAL_MS` (default 60s). |
| First `/v1/search` after `up` fails or hangs | TEI warms up for ~30-60s on CPU before serving. `docker compose logs -f tei-embeddings` until it reports ready. `/health` on signals-search is **unauthenticated and does not check the embedder**, so a 200 there does not mean the stack can serve a query. |
| `no matching manifest for linux/arm64/v8` on `up`/`pull` | Both published images are amd64-only and you are on arm64. The compose pins `platform: linux/amd64` so this should not happen — if it does, your compose is older than that change, or `SEARCH_PLATFORM` has been overridden to an arch the image does not have. |
| On arm64, the first `/v1/search` is very slow | Expected: TEI is running under emulation. Warmup is ~35s and each embed is slower than native. Build signals-search locally (`SIGNALS_SEARCH_IMAGE` + `SEARCH_PLATFORM=linux/arm64`) to make the *app* native; the embedder has no native option. |
| Config change to a search var seems ignored | signals-search reads its config **once at boot**. Restart the service: `docker compose --profile search restart signals-search-api signals-search-worker`. |

---

## 7. Optional — signals-search (relevance ranking + match score)

Everything above runs signals-dpg standalone: browse and discover work, but
results come back in recency order with no relevance ranking, and match scores
are unavailable. This section adds **signals-search** — a query API, an ingestion
worker, and the embedding server they both depend on.

### 7.1 Why it is opt-in

It is behind a compose **profile** rather than always-on because the embedding
server is the single heaviest thing in this stack: bge-m3 loads a ~2.3 GB ONNX
model on CPU and wants 3-8 GB to itself. Turning it on unconditionally would
roughly double the memory floor for developers who only need the API and UI.

Nothing about the default `docker compose up -d` changes by adding this section —
the three services and the signals-api wiring are both inert until you opt in.

### 7.2 Bring it up

```bash
cd signals-dpg/local-setup
cp .env.search.example .env.search      # see 7.3
docker compose --profile search up -d
```

The two images are **public on GHCR** — no `docker login`, and no
`signals-search` checkout is needed:

| Service | Image |
| --- | --- |
| `signals-search-api` (`:3100`) | `ghcr.io/blue-dots-economy/signals-search:develop` |
| `signals-search-worker` | same image, `node dist/worker/main.js` |
| `tei-embeddings` (internal) | `ghcr.io/blue-dots-economy/tei-bge-m3:cpu-1.7-bge-m3` |

> **On Apple Silicon / arm64 these run emulated.** Both images are **amd64-only**
> — signals-search's CI does not set `platforms:`, so it publishes only the
> runner's arch, and upstream HuggingFace TEI ships no arm64 `cpu-*` tag at all.
> The compose therefore pins `platform: linux/amd64`; without it `docker pull`
> fails outright with `no matching manifest for linux/arm64/v8`.
>
> Emulation is fine in practice — measured on an M-series host, TEI loads bge-m3
> and serves a 1024-dim embedding ~35s after start, and is not OOM-killed —
> just slower than native. There is no native embedder to switch to. For the
> search **app** you can avoid emulation by building it locally, since its
> Dockerfile builds cleanly on arm64:
>
> ```bash
> # in .env.search
> SIGNALS_SEARCH_IMAGE=signals-search:local
> SEARCH_PLATFORM=linux/arm64
> ```

The TEI image has **BAAI/bge-m3 baked in**, so nothing downloads the model at
runtime and there is no HuggingFace rate limit to hit. It is also the same model
production runs — worth keeping, because `model_version` feeds the ingest content
hash, so a different model means local relevance scores that do not correspond to
anything deployed.

> **Every `--profile search` command needs the flag**, including `ps`, `logs`,
> `restart` and `down`. `docker compose down` without it leaves the search
> containers running.

### 7.3 Wiring signals-api to it — the two-var-set trap

`.env.search` exists because signals-api needs **two separate config blocks** to
use signals-search, with different variable names for the same URL:

```bash
# Discover / relevance-ranked search  (GET|POST discover -> /v1/search)
SIGNALS_SEARCH_URL=http://signals-search-api:3100
SIGNALS_SEARCH_API_KEY=<raw apikey from 7.4>

# Match score  (-> /v1/relevance).  SAME URL, DIFFERENT VARIABLE NAME.
MATCH_SCORE_PROVIDER=signals_search
SIGNALS_SEARCH_ENDPOINT=http://signals-search-api:3100
```

Set only the first pair and discover ranks correctly while every match-score call
returns `503 MATCH_SCORE_NOT_CONFIGURED`. Set only the second and the reverse.

> **Why a separate file rather than entries in `.env`.** `MATCH_SCORE_PROVIDER`
> is validated as an enum, so an *empty* value is a hard boot failure — and
> compose's `environment:` mapping has no way to omit a key whose value is blank.
> The compose file therefore pulls these in via an optional `env_file`, which
> injects nothing at all when `.env.search` is absent. That is what keeps the
> non-search stack unaffected.

### 7.4 API key — there is no env var for it

signals-search authenticates every request against the **`apikey` table in the
shared Signals database**:

```sql
SELECT user_id FROM "apikey" WHERE key = sha256_base64url(<raw key>) AND enabled = true
```

So the key must be a real row: `enabled`, not past `expires_at`, `remaining`
null-or-positive, with a non-null `user_id`. Mint one with the §5 step:

```bash
docker compose run --rm signals-bootstrap sh -lc "pnpm --filter api db:seed:services"
```

It prints an `sk_signals_…` key **on first run only** — capture it and put the
**raw** value in `.env.search`. The database stores only the hash, so a lost key
cannot be recovered; re-seed to mint a new one.

This also means signals-search's `DATABASE_URL` must point at the **same**
database as signals-api. A separate database yields `401`s (no `apikey` rows) and
an empty index (no `items`).

### 7.5 `NETWORK_CONFIG_PATH` — a local file, not a URL

signals-search reads the network config off the **filesystem**. A GitHub
`blob`/raw URL will not work. This compose mounts the same `network.json` that
signals-api serves:

```
../examples/schemas/${SIGNALS_NETWORK:-blue_dot}/network.json  ->  /networks/network.json:ro
```

It must contain a top-level `id` matching the request's `networkId`, every served
domain under `domains[]` (both `seeker` **and** `provider`), interactions carrying
**all four** of `from_network`/`from_domain`/`to_network`/`to_domain`, and the
schema properties you want searchable marked `vectorize: true`. The bundled
`blue_dot` config satisfies all of this already.

> A **file** is mounted rather than a directory on purpose. In directory mode
> signals-search reads every `*.json`, and two files declaring the same `id`
> resolve last-one-wins — which can silently shadow the good config with a
> partial one.

### 7.6 The embedding dimension is locked in four places

signals-search runs no model in-process; it is an HTTP client to an
OpenAI-compatible `/embeddings` endpoint, used by the worker at index time and
the API at query time. `EMBEDDING_BASE_URL` must therefore end in **`/v1`** —
the client requests `${EMBEDDING_BASE_URL}/embeddings`.

One rule governs the dimension, and **three independent guards** enforce it:

```
model's native output dim  ==  EMBEDDING_DIM  ==  ITEM_SEARCH_VECTOR_DIM (code)  ==  item_search.embedding vector(N)
```

| Guard | Compares | Error |
| --- | --- | --- |
| Boot (`worker/main.ts`) | `EMBEDDING_DIM` vs the **code constant** | `EMBEDDING_DIM=… but item_search.embedding is vector(1024)` |
| Runtime (`embedding/provider.ts`) | what the model **actually emits** vs `EMBEDDING_DIM` | `unexpected embedding dimension X, expected Y` |
| Postgres (pgvector) | the inserted vector vs the column typmod | `expected 1024 dimensions, not 1536` |

`EMBEDDING_DIM` only **declares** what to expect — it does not resize the model.
Setting it to 1024 while the model still emits 1536 does not help.

Recommended models, so you can pick a matching pair without trial and error:

| Model | Dim | Note |
| --- | --- | --- |
| **`BAAI/bge-m3`** | **1024** | **The default here and in production.** Apache-2.0, served via TEI, baked into the image. |
| `BAAI/bge-large-en-v1.5` | 1024 | Also 1024 and would satisfy the guards — but relevance scores would not match production's. |
| `BAAI/bge-base-en-v1.5` | 768 | Needs the migration below. |
| OpenAI `text-embedding-3-small` / `-large` / `ada-002` | 1536 / 3072 / 1536 | **None are 1024.** All need the migration, plus `EMBEDDING_API_KEY`. signals-search does **not** send OpenAI's `dimensions` parameter, so a 1536-dim model cannot be shrunk by config. |

Moving off 1024 is a **code + migration** change, not an env tweak: bump the
`ITEM_SEARCH_VECTOR_DIM` constant *and rebuild `dist/`*, add a signals-dpg
migration that drops the HNSW index → `TRUNCATE item_search` → `ALTER COLUMN
embedding TYPE vector(N)` → recreates the index at the new width, then set
`EMBEDDING_DIM=N`. `item_search` is a derived read-model, so truncating it is
safe — the worker's sweep rebuilds it from `items`. **Never** clear `items`; it is
the source of truth.

> `item_search`'s DDL is owned by **signals-dpg** (`apps/api/db/postgres/schema.sql`
> and the `apps/api/drizzle/` ledger); the copies under signals-search's
> `src/db/migrations/` are a dev/test mirror. That is why `RUN_MIGRATIONS` stays
> `false` here — `signals-bootstrap` has already created the table, and the worker
> just asserts it exists.

### 7.7 Smoke test — `/health` is not enough

`/health` is unauthenticated and checks neither the database nor the embedder, so
a 200 from it only means the process is listening. The real test is a query:

```bash
curl -sS -X POST http://localhost:3100/v1/search \
  -H 'content-type: application/json' \
  -H "x-api-key: $SIGNALS_SEARCH_API_KEY" \
  -d '{
        "context": { "networkId": "blue_dot", "domain": "seeker" },
        "message": { "intent": { "text": "electrician in Ghaziabad" } }
      }'
```

A `200` with a ranked `results` array means the whole chain works: apikey row →
network config → embedder → pgvector index. Then confirm the ranking is actually
reaching the UI (no "showing basic matches" banner) and that a match score
resolves.

If `results` is empty, the index is simply not populated yet — the worker's sweep
runs every `SWEEP_INTERVAL_MS` (default 60s) and backfills from `items`.

### 7.8 Track B (hybrid) with search

Keep the search services in Docker and run only signals-api/UI from source —
building signals-search from a local checkout is only worth it if you are
changing signals-search itself:

```bash
docker compose --profile search up -d postgres redis tei-embeddings \
  signals-search-api signals-search-worker
```

Then point the host-run API at it by adding the §7.3 variables to the
**repo-root** `.env`, using `http://localhost:3100` instead of the compose
service name.

To run signals-search from source instead, override the image with a local
build: `SIGNALS_SEARCH_IMAGE=signals-search:local` in `.env.search` after
building that repo's Dockerfile.
