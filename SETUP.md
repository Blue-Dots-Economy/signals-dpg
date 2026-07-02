# Local Setup

Get the app running on your machine. Follow the steps in order.

**Steps 1–5** run the **Signals DPG** backend + UI on their own — that's all
most people need. The optional **aggregator-dpg** integration is at the end.

By default this runs the **blue_dot** network. To run a different one, see
[Choose a network](#choose-a-network).

## What you need first

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | `>= 24` | `node -v` |
| **pnpm** | `>= 10` | Turn on with `corepack enable pnpm` (auto-uses the pinned `pnpm@11.1.2`). Don't use npm. |
| **Docker** + Compose v2 | recent | Use `docker compose` (v2), not legacy `docker-compose`. |
| **openssl** | any | Generate the PII key. |
| **git** | any | |
| **make** | GNU Make | **Aggregator only.** Not on Windows — see [Windows](#running-on-windows-no-make). |

Quick check:

```bash
node --version        # v24.x
pnpm --version        # 10.x+  (or run: corepack enable pnpm)
docker compose version
openssl version
```

---

## Step 1 — Install

```bash
pnpm install
```

## Step 2 — Make your settings file

There is **one** settings file at the repo root. It holds everything: backend,
database, cache, and the website (`VITE_*`) values. There is **no** separate
`apps/ui/.env` — Vite reads `VITE_*` from this same file via `pnpm dev:ui`.

```bash
cp .env.example .env
```

Now set the values below. Most fields already have working defaults — only
these matter for a local blue_dot run.

First make a secret key (a blank `SIGNALS_PII_KEY` crashes the API at boot):

```bash
openssl rand -base64 32
```

Then set these lines in `.env`:

```dotenv
SIGNALS_PII_KEY='paste-the-key-you-just-generated'
SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"
NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/blue_dot/network.json"
VITE_API_URL=http://localhost:2742
VITE_NETWORK_ID=blue_dot
```

Leave everything else as-is — the defaults work. Sanity-check the connection
block matches the compose ports:

```dotenv
API_PORT="2742"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT=5432
REDIS_HOST="127.0.0.1"
REDIS_PORT=5555
```

> **Tip:** `SIGNALS_PII_KEY` is unique per developer — always generate your own.

## Step 3 — Start the database + cache

The Signals compose file only defines the two backing stores (`db`, `redis`);
the API and UI run on the host.

```bash
docker compose up -d db redis
```

Check both say `healthy`:

```bash
docker compose ps        # dpg-db and dpg-redis should be (healthy)
```

(Redis is the cache. Docker sets it up for you — nothing else to do.)

## Step 4 — Set up the database (first time only)

Run from the repo root, in order:

```bash
pnpm db:push:api           # apply better-auth + Drizzle schema
pnpm db:init:api           # apply partitioned items / actions / events tables
pnpm db:seed:services:api  # create the service user + apikey
```

- `db:push` may **prompt to confirm** — accept to proceed.
- The seed is **idempotent**. The raw apikey is printed **only on first mint** —
  capture it if you'll run the aggregator (see below). If lost, delete the
  `apikey` row and re-run the seed.

> **Only if integrating the aggregator:** the seed prints an `org_id` and an
> `apikey` (`sk_signals_…`). Keep both — you'll paste them into the aggregator's
> env in the [aggregator section](#optional--run-with-the-aggregator-dpg).

## Step 5 — Run it

Open two terminals:

```bash
pnpm dev:api      # terminal 1 — API on http://localhost:2742
```

```bash
pnpm dev:ui       # terminal 2 — UI on http://localhost:5173
```

Confirm the API is up:

```bash
curl -s http://localhost:2742/api/v1/network/schemas | head
```

## Done

Open **http://localhost:5173** in your browser.

---

## Choose a network

Default is **blue_dot**. To run another network, change these lines in `.env`
and restart both `dev:api` and `dev:ui`.

| Network | `NETWORK_CONFIG_LOCAL_FILE` | `SERVED_DOMAINS` | `VITE_NETWORK_ID` |
|---------|-----------------------------|------------------|-------------------|
| blue_dot *(default)* | `../../examples/schemas/blue_dot/network.json` | `blue_dot/seeker,blue_dot/provider` | `blue_dot` |
| purple_dot | `../../examples/schemas/purple_dot/network.json` | `purple_dot/seeker,purple_dot/provider` | `purple_dot` |
| orange_dot | `../../examples/schemas/orange_dot/network.json` | `orange_dot/practitioner` | `orange_dot` |
| yellow_dot | `../../examples/schemas/yellow_dot/network.json` | `onest_yellow_dot/student` | `onest_yellow_dot` |

---

## Optional — use Google Maps

The map works out of the box with **Leaflet** (free, no key). To use Google
Maps instead, set these two lines in `.env` and restart `pnpm dev:ui`:

```dotenv
VITE_MAP_PROVIDER=google-maps
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key
```

Get a key from the [Google Cloud Console](https://console.cloud.google.com/):
create a project → enable the **Maps JavaScript API** (and **Geocoding API**
if you want address search) → create an API key. The key must **not** be
HTTP-referrer restricted for local use.

(Mapbox also works: `VITE_MAP_PROVIDER=mapbox` + `VITE_MAPBOX_ACCESS_TOKEN=...`.)

---

## Optional — run with the aggregator-dpg

Bring-up is one-directional: **Signals comes up first** and mints a service
apikey + org id (Step 4); the **aggregator** is then pointed at Signals with
those two secrets.

```
┌────────────────────┐   x-api-key + x-acting-org-id   ┌────────────────────┐
│  aggregator-dpg     │ ───────────────────────────────▶│   Signals-DPG       │
│  (docker compose)   │  ADMIN_KEY / ACTING_ORG_ID       │   api on :2742       │
└────────────────────┘                                   └────────────────────┘
```

**Prerequisite — `/etc/hosts`.** The aggregator's Keycloak and MinIO run in
containers reachable by hostname. Add once per machine (`make setup` does this
for you, or add by hand):

```bash
grep -E 'keycloak|minio' /etc/hosts
#   127.0.0.1 keycloak
#   127.0.0.1 minio
```

**1. Clone the aggregator** side-by-side with Signals-DPG:

```bash
git clone <aggregator-dpg-remote> ../aggregator-dpg
cd ../aggregator-dpg
```

**2. Create its env.** First time on a machine:

```bash
make setup     # copies infra/env.local (or env.template) → .env, adds /etc/hosts entries
```

If `.env` and the hosts entries already exist, `make setup` is a no-op — skip it.

**3. Point the aggregator at Signals** using the seed values from Step 4. The
aggregator runs in Docker, Signals runs on the host, so reach the host via
`host.docker.internal`:

```dotenv
# aggregator-dpg/.env
SIGNALSTACK_BASE_URL=http://host.docker.internal:2742
SIGNALSTACK_ADMIN_KEY=sk_signals_…      # apikey from the Signals seed
SIGNALSTACK_ACTING_ORG_ID=org_…         # org_id from the Signals seed
SIGNALSTACK_TIMEOUT_MS=10000
```

Also fill any `change-me-*` placeholders (`openssl rand -hex 32`).

> Leaving `SIGNALSTACK_BASE_URL` blank **disables** the push to Signals. When
> set, `SIGNALSTACK_ADMIN_KEY` + `SIGNALSTACK_ACTING_ORG_ID` are both required.

**4. Bring up the full stack:**

```bash
make up        # docker compose up -d --build (postgres, redis, minio, keycloak, api, web, worker, nginx)
make ps
make logs
```

The aggregator runs its **own** Postgres (`:5433`), Redis (`:6379`), Keycloak
(`:8080`), MinIO, and Mailpit (`:8025`) — independent of the Signals containers.

**5. Verify the integration** — exercise the aggregator → Signals auth path
directly with the seed secrets:

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H "x-api-key: $SIGNALSTACK_ADMIN_KEY" \
  -H "x-acting-org-id: $SIGNALSTACK_ACTING_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{ "external_id": "agg_bbmp_001", "name": "BBMP", "slug": "bbmp" }'
# -> { "org_id": "org_<uuid>", "created": true }
```

A `200/201` with an `org_id` confirms the auth path works.

### Running on Windows (no `make`)

The aggregator's `Makefile` recipes are POSIX shell — Windows has no native
`make`, and GnuWin make doesn't help (it runs recipes through `cmd.exe`). Don't
fight it: `make` is just a thin wrapper, so run the underlying commands directly
in **PowerShell**. Docker Desktop, `docker compose`, `pnpm`, and `openssl` all
work natively on Windows. Steps 1–5 (Signals) are unchanged; only the
aggregator's `make` steps need substitutes.

**One-time setup** (replaces `make setup`):

```powershell
# from aggregator-dpg/
Copy-Item infra\env.local .env        # or infra\env.template
# add hostnames (Administrator PowerShell):
Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "127.0.0.1 keycloak`r`n127.0.0.1 minio"
```

**Daily commands** (from `aggregator-dpg/` in PowerShell):

| `make` target | Run directly |
|---|---|
| `make up` | `docker compose up -d --build` |
| `make down` | `docker compose down` |
| `make ps` | `docker compose ps` |
| `make logs` | `docker compose logs -f` |
| `make reset` *(destroys volumes)* | `docker compose down -v` |
| `make psql` | `docker compose exec postgres psql -U aggregator -d aggregator` |
| `make redis-cli` | `docker compose exec redis redis-cli` |

`host.docker.internal` resolves correctly on Docker Desktop for Windows, so
`SIGNALSTACK_BASE_URL` is unchanged.

---

## Daily / restart cheatsheet

```bash
# Signals (host processes + 2 containers)
cd Signals-DPG
docker compose up -d db redis
pnpm dev:api          # terminal 1
pnpm dev:ui           # terminal 2

# Aggregator (full docker stack)
cd ../aggregator-dpg
make up               # or: make down (stop), make reset (DESTROYS volumes)
```

---

## If something breaks

| Problem | Fix |
|---------|-----|
| App won't start, error mentions `SIGNALS_PII_KEY` | You skipped Step 2. Run `openssl rand -base64 32` and paste it into `.env`. |
| `npm` errors | Use pnpm, not npm: `corepack enable pnpm`, then `pnpm install`. |
| Website loads but shows no data / "connection refused" | In `.env` set `VITE_API_URL=http://localhost:2742`. |
| "cannot find network.json" | In `.env`, the path must start with `../../` — e.g. `../../examples/schemas/blue_dot/network.json`. |
| `PARTITION_SETUP_FAILED` | You skipped Step 4. Run `pnpm db:init:api`. |
| Page won't load / database error | Docker not up. Run `docker compose up -d db redis` and wait for `healthy`. |
| Port already in use | Change `API_PORT` (API), `VITE_UI_PORT` (UI), `DATABASE_PORT`, or `REDIS_PORT` in `.env`. |
| Can't log in | In `.env` set `CREATE_TEST_OTP=true`, restart the API, then use the test OTP. |
| Aggregator can't reach Signals | Use `SIGNALSTACK_BASE_URL=http://host.docker.internal:2742` (not `localhost`) — the aggregator is in Docker. |

---

## References

- `readme.md`, `AGENTS.md`
- `docs/operations/integrating-dpgs.md` — the two-header service-auth model
- `docs/operations/secrets.md` — full env-var matrix
- `aggregator-dpg/SETUP.md` — aggregator stack + Keycloak mappers
- `aggregator-dpg/Makefile` — `make help` lists every target
