# Local Setup Guide — signals-dpg (Signals Stack)

A single, self-contained guide for bringing up **signals-dpg alone** — the API,
the UI, and only its own backing dependencies (Postgres + Redis) — on a fresh
machine. Two tracks:

| Track               | You want to…                                                    | Follow            |
| ------------------- | --------------------------------------------------------------- | ----------------- |
| **A — Docker-only** | Just get signals running to explore/demo. One command.          | §1 → §2 → §3      |
| **B — Hybrid dev**  | Write code with hot-reload; run the API/UI from source.         | §1 → §4 (2 steps) |

This tooling (`docker-compose.yml`, `.env.example`, `infra/`) lives **inside the
signals-dpg repo at `signals-dpg/local-setup/`** and builds only this repo — no
sibling repos, no aggregator, no Keycloak. Run everything from **`local-setup/`**
(Track A) or the repo root (Track B).

> **⚠️ Memory guidance.** Track A builds **3 images** (bootstrap tools, API, UI)
> and runs ~5 containers. On a low-memory machine (Docker capped ~4 GB), a first
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
