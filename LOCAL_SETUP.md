# Local Setup — Signals-DPG + aggregator-dpg

End-to-end walkthrough for running the **Signals DPG** backend/UI and the
**Aggregator DPG** stack together on one machine, starting from a fresh
`git clone`.

The integration is one-directional during bring-up: **Signals comes up first**
and mints a service apikey + org id; the **aggregator** is then pointed at
Signals with those two secrets. So always start Signals, capture its seed
output, then start the aggregator.

```
┌────────────────────┐     x-api-key + x-acting-org-id      ┌────────────────────┐
│  aggregator-dpg     │ ───────────────────────────────────▶│   Signals-DPG       │
│  (docker compose)   │   SIGNALSTACK_ADMIN_KEY / ACTING_ORG │   api on :2742       │
└────────────────────┘                                       └────────────────────┘
```

---

## 0. Prerequisites (CLI tools)

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | `>= 24` | Signals pins `>=24` (`engines`); aggregator CI pins Node 24 (Node 22 works locally). |
| **pnpm** | `>= 10` | Signals pins `pnpm@11.1.2` via `packageManager`. Run `corepack enable pnpm` once — corepack then auto-switches to the pinned version per repo. |
| **Docker** + **Compose v2** | recent | `docker compose` (v2 plugin syntax), not the legacy `docker-compose`. |
| **git** | any | |
| **make** | any (GNU Make) | Used by aggregator only. **Not available on Windows** — see [Running on Windows (no `make`)](#running-on-windows-no-make). |
| **openssl** | any | Generate secrets (`SIGNALS_PII_KEY`, `AUTH_SECRET`, etc.). |

Quick check:

```bash
node --version        # v24.x
pnpm --version        # 10.x+ (or run: corepack enable pnpm)
docker compose version
make --version
openssl version
```

**`/etc/hosts` (aggregator, docker-only mode).** The aggregator's Keycloak
runs in a container reachable by the hostname `keycloak`, and MinIO by `minio`.
The browser (OIDC redirects) and containers must resolve both to localhost:

```bash
grep -E 'keycloak|minio' /etc/hosts
# expect:
#   127.0.0.1 keycloak
#   127.0.0.1 minio
```

If missing, `make setup` adds them (see §5). They only need to be added once
per machine.

---

## 1. Clone both repos

Clone side-by-side under the same parent directory:

```bash
git clone <signals-dpg-remote>     Signals-DPG
git clone <aggregator-dpg-remote>  aggregator-dpg
```

---

## 2. Signals-DPG — install + configure env

```bash
cd Signals-DPG
pnpm install
cp env.example .env
```

Edit `.env`. The defaults boot fine for local dev; the one value you **must**
generate is the PII master key (required by Zod validation at boot — a blank
value crashes the API):

```bash
# generate and paste into SIGNALS_PII_KEY in .env
openssl rand -base64 32
```

Sanity-check the local connection block in `.env` matches the compose ports:

```bash
INSTANCE_ENV="development"
API_PORT="2742"
SERVED_DOMAINS="onest_yellow_dot/student"   # or blue_dot/seeker etc.
NETWORK_CONFIG_SOURCE="local"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT=5432
REDIS_HOST="127.0.0.1"
REDIS_PORT=5555
SIGNALS_PII_KEY="<paste openssl output>"
```

> Compose reads `.env` for `POSTGRES_*` / `REDIS_*` / `DATABASE_PORT`, so the
> same file drives both the containers and the API process.

---

## 3. Signals-DPG — bring up Postgres + Redis only

The Signals compose file only defines the two backing stores (`db`, `redis`) —
the API and UI run on the host via `pnpm dev:*`.

```bash
docker compose up -d db redis
```

Verify both are healthy:

```bash
docker compose ps        # dpg-db and dpg-redis should be (healthy)
```

---

## 4. Signals-DPG — migrate, bootstrap, seed

Run from the repo root, in order. (These three scripts read `../../.env`
directly, so they work without the turbo env loader.)

```bash
pnpm db:push:api          # apply better-auth + Drizzle schema to Postgres
pnpm db:init:api          # apply the non-Drizzle SQL bootstrap (items / actions / events)
pnpm db:seed:services:api # create the aggregator-dpg service user + apikey
```

- `db:push` may **prompt to confirm** applying the generated statements —
  **agree** (accept) to proceed.
- The seed is **idempotent**. The raw apikey is printed **only on first mint** —
  capture it now. If lost, delete the `apikey` row and re-run the seed.

### Copy the secrets

The seed prints something like:

```
aggregator-dpg:
  org_id:    org_7c738a1d-a9bc-4d3b-a394-ecb9c607c77c
  user_id:   usr_...
  member_id: mem_...
  apikey:    sk_signals_9437972f1b6b9361e118b07db87c7fddb852cf360579a1f3
             ↑ raw key — NOT SHOWN AGAIN. Capture now.
```

Keep two values for §6:

| Seed field | Aggregator env var |
|---|---|
| `apikey` (`sk_signals_…`) | `SIGNALSTACK_ADMIN_KEY` |
| `org_id` (`org_…`) | `SIGNALSTACK_ACTING_ORG_ID` |

### UI env

```bash
cp apps/ui/env.example apps/ui/.env
```

Point the UI at the local API (the example default is `:3000` — change it):

```bash
# apps/ui/.env
VITE_API_URL=http://localhost:2742
VITE_MAP_PROVIDER=leaflet
```

---

## 5. Signals-DPG — run API + UI

In two terminals (or background one):

```bash
pnpm dev:api    # Fastify API on http://localhost:2742
pnpm dev:ui     # Vite UI (talks to VITE_API_URL)
```

Confirm the API is up before starting the aggregator:

```bash
curl -s http://localhost:2742/api/v1/network/schemas | head
```

---

## 6. aggregator-dpg — env + bring-up

```bash
cd ../aggregator-dpg
```

`make setup` does exactly two things — `make env` + `make hosts`:

1. **`make env`** — copies `infra/env.local` (preferred) or `infra/env.template`
   → `.env` (mode 600) **only if `.env` does not already exist**. On a hot
   install where `.env` is already present, this is a **no-op**
   (`".env already exists — leaving untouched."`).
2. **`make hosts`** — appends `127.0.0.1 keycloak` and `127.0.0.1 minio` to
   `/etc/hosts` (needs sudo). Idempotent — **skips entries already present**.

**Verdict:**
- **First time on a machine** → run `make setup` (it creates `.env` and adds the
  hosts entries).
- **Hot install** (you already have a populated `.env` *and* the `/etc/hosts`
  entries from §0) → **`make setup` is not required**; both halves are no-ops.
  Go straight to editing `.env` and `make up`.

If you only need the hosts entries (e.g. `.env` exists but `/etc/hosts` doesn't),
run `make hosts` on its own.

> Note: `make up` hard-requires `.env` to exist or it aborts with
> `".env missing — run 'make setup' first"`.

### Update the aggregator env

Set the three Signals-integration vars in the aggregator's root `.env` using the
values captured in §4. Because the aggregator runs in Docker and Signals runs on
the host, reach the host via `host.docker.internal`:

```bash
# aggregator-dpg/.env
SIGNALSTACK_BASE_URL=http://host.docker.internal:2742
SIGNALSTACK_ADMIN_KEY=sk_signals_…            # apikey from the Signals seed
SIGNALSTACK_ACTING_ORG_ID=org_…               # org_id from the Signals seed
SIGNALSTACK_TIMEOUT_MS=10000
```

> Leaving `SIGNALSTACK_BASE_URL` blank **disables** the outbound onboarding push
> to Signals. When set, `SIGNALSTACK_ADMIN_KEY` + `SIGNALSTACK_ACTING_ORG_ID`
> are both required.

Also fill any `change-me-*` placeholders in `.env` (generate with
`openssl rand -hex 32`).

### Compose up

```bash
make up        # == docker compose up -d --build  (full stack: postgres, redis, minio, keycloak, api, web, worker, nginx)
make ps        # check status
make logs      # tail everything
```

The aggregator brings up its **own** Postgres (`:5433`), Redis (`:6379`),
Keycloak (`:8080`), MinIO, and Mailpit (`:8025`) — these are independent of the
Signals containers.


## 7. Verify the integration

When an aggregator is approved/registered in the aggregator portal, it is
mirrored into Signals via `POST /api/v1/admin/aggregator/upsert`. You can
exercise that path directly with the seed secrets:

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H "x-api-key: $SIGNALSTACK_ADMIN_KEY" \
  -H "x-acting-org-id: $SIGNALSTACK_ACTING_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{ "external_id": "agg_bbmp_001", "name": "BBMP", "slug": "bbmp" }'
# -> { "org_id": "org_<uuid>", "created": true }
```

A `200/201` with an `org_id` confirms the aggregator → Signals auth path works.

---

## Running on Windows (no `make`)

The aggregator's `Makefile` recipes are POSIX shell scripts (`[ -f .env ]`,
`cp`, `chmod 600`, `sudo tee -a /etc/hosts`, `docker compose down -v`). On
Windows there is **no native `make`**, and GnuWin/GnuWin32 make does **not**
help — it runs each recipe through `cmd.exe`, which can't interpret those
scripts. The symptom is errors like `-f`/`-v` being "unexpected" or
"unrecognized" (cmd choking on `[ -f .env ]` and `docker compose down -v`).

Do **not** try to make native `make` work. Instead bypass it: `make` is only a
thin wrapper, so run the underlying commands directly in **PowerShell**. Docker
Desktop, `docker compose`, `pnpm`, and `openssl` all work natively on Windows —
only the `make` layer is missing.

Everything in §1–§5 (Signals-DPG) is cross-platform and unchanged. Only the
aggregator's `make` steps in §6 need the substitutions below.

### One-time setup (replaces `make setup`)

`make setup` does just two things — create `.env`, and add two hostnames.

**1. Create `.env`** (replaces `make env`). `chmod 600` is a Unix file-mode and
has no meaning on NTFS — just skip it.

```powershell
# from the aggregator-dpg/ directory
Copy-Item infra\env.local .env        # or infra\env.template if env.local is absent
```

**2. Add the `keycloak` + `minio` hostnames** (replaces `make hosts`). The
Windows hosts file lives at `C:\Windows\System32\drivers\etc\hosts` and needs
Administrator rights to edit. In an **Administrator PowerShell**:

```powershell
Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "127.0.0.1 keycloak`r`n127.0.0.1 minio"
```

Or edit the file by hand (open Notepad *as Administrator*, then
`File ▸ Open` → `C:\Windows\System32\drivers\etc\hosts`) and add:

```
127.0.0.1 keycloak
127.0.0.1 minio
```

Verify:

```powershell
Select-String -Path "$env:windir\System32\drivers\etc\hosts" -Pattern "keycloak|minio"
```

Then edit `.env` exactly as in §6 — fill the `change-me-*` placeholders
(`openssl rand -hex 32`) and set the three Signals-integration vars. The
`SIGNALSTACK_BASE_URL=http://host.docker.internal:2742` value is unchanged:
`host.docker.internal` resolves correctly on Docker Desktop for Windows.

### Daily commands (replaces `make up`, `make down`, …)

Run these from the `aggregator-dpg/` directory in PowerShell:

| `make` target | Run directly |
|---|---|
| `make up` | `docker compose up -d --build` |
| `make down` | `docker compose down` |
| `make ps` | `docker compose ps` |
| `make logs` | `docker compose logs -f` |
| `make reset` *(destroys volumes)* | `docker compose down -v` |
| `make psql` | `docker compose exec postgres psql -U aggregator -d aggregator` |
| `make redis-cli` | `docker compose exec redis redis-cli` |

> The `make up` guard (`.env` must exist) is gone when you bypass `make`, so
> double-check you completed step 1 above — a missing `.env` will surface as
> empty/`change-me-*` env values inside the containers instead of a clean abort.

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

## Useful references

- `Signals-DPG/readme.md`, `Signals-DPG/AGENTS.md`
- `Signals-DPG/docs/operations/integrating-dpgs.md` — the two-header auth model
- `Signals-DPG/docs/operations/secrets.md` — full env-var matrix
- `aggregator-dpg/SETUP.md` — full local-stack walkthrough + Keycloak mappers
- `aggregator-dpg/Makefile` — `make help` lists every target
