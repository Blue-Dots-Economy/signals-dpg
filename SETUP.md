# Local Setup

Get the app running on your machine. ~5 minutes. Follow the steps in order.

By default this runs the **blue_dot** network. To run a different one, see
[Choose a network](#choose-a-network) at the end.

## What you need first

- **Node.js 24+** — check: `node -v`
- **Docker Desktop** — running
- **pnpm** — turn it on with: `corepack enable`

(This project uses **pnpm**, not npm. Don't run `npm install`.)

---

## Step 1 — Install

```bash
pnpm install
```

## Step 2 — Make your settings file

There is **one** settings file at the repo root. It holds everything: backend,
database, cache, and the website (`VITE_*`) values.

```bash
cp .env.example .env
```

Now set the values below. Most fields already have working defaults — only
these matter for a local blue_dot run.

First make a secret key:

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

Leave everything else as-is — the defaults work.

> **Tip:** `SIGNALS_PII_KEY` is unique per developer — always generate your own.
> The other four lines can be baked into `.env.example` so a fresh copy already
> targets blue_dot.

## Step 3 — Start the database + cache

```bash
docker compose up -d db redis
```

Wait a few seconds, then check both say `healthy`:

```bash
docker compose ps
```

(Redis is the cache. Docker sets it up for you — nothing else to do.)

## Step 4 — Set up the database (first time only)

```bash
pnpm db:push:api
pnpm db:init:api
pnpm db:seed:services:api
```

## Step 5 — Run it

Open two terminals:

```bash
pnpm dev:api      # terminal 1
```

```bash
pnpm dev:ui       # terminal 2
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

## If something breaks

| Problem | Fix |
|---------|-----|
| App won't start, error mentions `SIGNALS_PII_KEY` | You skipped Step 2. Run `openssl rand -base64 32` and paste it into `.env`. |
| `npm` errors | Use pnpm, not npm: `corepack enable`, then `pnpm install`. |
| Website loads but shows no data / "connection refused" | In `.env` set `VITE_API_URL=http://localhost:2742`. |
| "cannot find network.json" | In `.env`, the path must start with `../../` — e.g. `../../examples/schemas/blue_dot/network.json`. |
| `PARTITION_SETUP_FAILED` | You skipped Step 4. Run `pnpm db:init:api`. |
| Page won't load / database error | Docker not up. Run `docker compose up -d db redis` and wait for `healthy`. |
| Port already in use | Change `API_PORT` (API), `VITE_UI_PORT` (UI), `DATABASE_PORT`, or `REDIS_PORT` in `.env`. |
| Can't log in | In `.env` set `CREATE_TEST_OTP=true`, restart the API, then use the test OTP. |
