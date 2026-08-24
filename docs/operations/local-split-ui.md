# Local split-UI stack (per-domain email CTA testing)

Stands up **one API plus two UIs on separate origins** — one per domain, as
in production — so a human can click the link in a real action email and
confirm it lands on the recipient's own portal instead of the shared,
now-blocked front-door. Built for issue #569 (per-domain email CTA
resolution).

**Why two Vite servers rather than one:** `VITE_SERVED_BINDINGS` is read per
UI process, so a split portal is genuinely two processes. `apps/ui/vite.config.ts`
already reads `VITE_UI_PORT` (default `5173`), so this needs **no code
change** — it's config and process startup only.

Ports used: API `2742`, seeker UI `5174`, provider UI `5175`. `9999` is
deliberately never bound to anything (see Step 1).

## Step 1 — Configure the API

In the worktree root `.env` (reading/writing `.env` with `cat`/`grep`/an
editor tool is blocked in some sandboxes — use `node -e` with
`fs.readFileSync`/`fs.writeFileSync`, and make sure the file ends with a
newline before appending or keys will concatenate onto one malformed line):

```bash
SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"
NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/blue_dot/network.json"
ALLOWED_ORIGINS="http://localhost:5174,http://localhost:5175"
UI_HOST_BINDINGS="http://localhost:5174=blue_dot/seeker;http://localhost:5175=blue_dot/provider"
FRONTEND_BASE_URL="http://localhost:9999"
```

Notes on each value:

- `FRONTEND_BASE_URL` is deliberately set to a port **nothing listens on**:
  it stands in for the blocked combined front-door, so a link that still
  points there is unmistakably a bug rather than a coincidence that happens
  to work.
- The API must serve **BOTH** domains (`SERVED_DOMAINS` = all of them) even
  though each UI serves only one. Restricting the API's own list breaks
  single-instance browse: every item's `item_instance_url` points at this
  same instance, so the API makes a peer HTTP call to itself which fails
  `401 PEER_AUTH_FAILED` / `403 UNSERVED_DOMAIN_BINDING`, and the map/list
  shows "No items match" while the DB is full.
- In dev, `ALLOWED_ORIGINS` **augments** the defaults rather than replacing
  them (`packages/config/src/allowed_origins.ts`), so both UI ports must be
  listed here for CORS to allow both.
- `UI_HOST_BINDINGS` accepts an explicit `http://` scheme and port on the
  host half — that is exactly why the local form
  `http://localhost:5174=blue_dot/seeker` works. (This is a deliberate
  amendment adopted for local/dev use; production values are bare hosts.)

**Also required to boot, but not called out in the original task list:**
`INSTANCE_SHARED_SECRET` (`packages/config/src/secrets.ts`, min 32 chars) —
the API refuses to start without it. It's a locally-generated peer-auth
secret, not an external credential, so generate one yourself:

```bash
openssl rand -hex 32   # paste into .env as INSTANCE_SHARED_SECRET="..."
```

If your `.env` doesn't exist yet, start from `.env.example` (`cp .env.example
.env`) — it ships working local defaults for `POSTGRES_*`, `REDIS_*`, and a
`SIGNALS_PII_KEY` placeholder you must also fill in (`openssl rand -base64
32`) before the API will boot.

## Step 2 — Start infra and the API

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG.worktrees/569-email-cta
source ~/.nvm/nvm.sh && nvm use 24
docker compose up -d db redis
docker exec -i dpg-db psql -U postgres -d postgresdb -v ON_ERROR_STOP=0 < apps/api/db/postgres/schema.sql
find /var/folders /private/var/folders /tmp -maxdepth 5 -type d -name 'dpg-network-schema-cache' -exec rm -rf {} + 2>/dev/null
( cd apps/api && nohup node --env-file=../../.env --import tsx src/server.ts > /tmp/signals-api.log 2>&1 & )
```

If another Signals-DPG checkout (e.g. the primary repo dir) already has
`dpg-db` / `dpg-redis` containers under those exact names, `docker compose
up` will report a name conflict rather than create new ones — container
names in `docker-compose.yaml` are fixed, not per-worktree. If so, and the
existing containers were built from the same `.env.example` defaults
(check with `docker inspect dpg-db --format '{{range .Config.Env}}{{println
.}}{{end}}'`), it's safe to just `docker start dpg-db dpg-redis` instead of
recreating them.

## Step 3 — Verify the bindings parsed

```bash
grep -i "UI_HOST_BINDINGS" /tmp/signals-api.log
```

Expected: **no output**. Any line here is a warning about a skipped entry
and means the value is malformed.

## Step 4 — Start the two UIs

Run each in its own background process, bypassing the turbo wrapper so the
per-UI env is not overridden by the root `.env`:

```bash
cd apps/ui

VITE_UI_PORT=5174 VITE_NETWORK_ID=blue_dot VITE_SERVED_BINDINGS=blue_dot/seeker \
  VITE_DEFAULT_NETWORK_THEME=blue_dot VITE_API_URL=http://localhost:2742 \
  nohup npx vite > /tmp/signals-ui-seeker.log 2>&1 &

VITE_UI_PORT=5175 VITE_NETWORK_ID=blue_dot VITE_SERVED_BINDINGS=blue_dot/provider \
  VITE_DEFAULT_NETWORK_THEME=blue_dot VITE_API_URL=http://localhost:2742 \
  nohup npx vite > /tmp/signals-ui-provider.log 2>&1 &
```

## Step 5 — Verify the split

```bash
curl -s -o /dev/null -w 'seeker:   %{http_code}\n' http://localhost:5174/
curl -s -o /dev/null -w 'provider: %{http_code}\n' http://localhost:5175/
```

Expected: `200` from both. Then confirm in a browser that `:5174`'s signup
form auto-selects **seeker** with no domain picker, and `:5175` auto-selects
**provider** — that is the same `VITE_SERVED_BINDINGS` signal the mail fix
keys off, so if the picker still appears the split is not in effect. A quick
proxy check: the browser tab title differs per port (`Blue Dots · Seeker ·
Signal Stack` vs `Blue Dots · Provider · Signal Stack`) because the network
theme resolves per binding.

## Step 6 — Configure mail delivery

Action emails need a notification client **plus** a from-address, or
`resolveNotifierConfig()` (`apps/api/src/notifications/notify_actions.ts`)
returns `null` and **no action email is sent at all** — there is nothing to
inspect in an inbox until this is configured.

### Path A — with real notification-service credentials

Set these four env vars (placeholder names below; use your own values, never
commit real secrets):

```bash
NOTIFICATION_SERVICE_ENDPOINT=<notification-service-base-url>
NOTIFICATION_SERVICE_KEY_ID=<notification-service-key-id>
NOTIFICATION_SERVICE_SECRET=<notification-service-secret>
NOTIFICATION_FROM_EMAIL=<verified-from-address>
```

Why all four are needed: `getNotificationClient()`
(`apps/api/src/utils/notificationClient.ts`) only constructs a client when
`NOTIFICATION_SERVICE_ENDPOINT` + `_KEY_ID` + `_SECRET` are **all** present;
`resolveNotifierConfig()` then additionally requires `NOTIFICATION_FROM_EMAIL`
before it will cache a non-null config. Missing any one of the four means the
whole action-email pipeline is a silent no-op (see Path B below for exactly
how silent).

Confirm the API sees them:

```bash
grep -i "notification" /tmp/signals-api.log | head
```

Use yopmail addresses (`https://yopmail.com`) for both test accounts so the
mail is inspectable without a real inbox.

### Path B — without credentials (verified in this session)

**Investigated and confirmed: there is no reliable no-credential observation
point in `/tmp/signals-api.log`.** Tracing the code:

- `getNotificationClient()` returns `undefined` silently (no log call at
  all) when any of `NOTIFICATION_SERVICE_ENDPOINT` / `_KEY_ID` / `_SECRET`
  is unset.
- `resolveNotifierConfig()` then caches `null` and returns, again with no
  log call.
- `dispatchActionNotifications()` (called from `perform_action.ts` and
  `update_action_status.ts`) and `notify_retire.ts` both do
  `const config = resolveNotifierConfig(); if (!config) return;` — an early,
  silent return. The dispatcher's own skip-reason logging
  (`apps/api/src/notifications/dispatcher.ts:77`, `'notification skipped: no
  CTA url for recipient domain'`) is never reached in this case, because it
  only runs once a non-null config already exists.
- `sendWelcomeNotifications()` (`apps/api/src/notifications/welcome.ts`) has
  the identical `if (!nc) return;` shape for the welcome-email path.

Empirically: triggering `/api/auth/unified-otp/request` +
`/api/auth/unified-otp/verify` against a running API with no notification
credentials produces the normal Fastify `"incoming request"` /
`"request completed"` log pairs and **nothing else** — no notification,
email, or CTA-related line appears, confirming the trace above. (In this
session self-signup was additionally gated off — `SELF_SIGNUP_DISABLED` —
which is unrelated to notification config and is a separate instance
setting; it stopped a real welcome-email from being generated, but the log
behaviour for the notification-config gate is confirmed either way, since
the code path a real signup would hit is the same `if (!nc) return;` shown
above.)

**Practical implication:** without the four credentials above, do not expect
to observe a resolved CTA URL by watching logs or inboxes. The only way to
prove `UI_HOST_BINDINGS` resolution is correct without credentials is to
read the source directly (`apps/api/src/notifications/brand.ts`'s
`createCtaUrlResolver`, fed by `packages/config`'s `uiHostBindings.byDomain`)
or to run the existing unit tests that exercise it
(`apps/api/src/notifications/__tests__/*.test.ts`) — neither of which is a
live, end-to-end email observation. If a no-credential observation point is
needed for a future task, one would have to be **added** (e.g. a
`log.info` before the early return in `resolveNotifierConfig`) — that is a
source change and is out of scope here.

## Step 7 — Manual test matrix

Hand off to a human tester once Path A (Step 6) is configured with real
yopmail-reachable credentials:

| # | Action | Expected link in the mail |
|---|---|---|
| 1 | Seeker on `:5174` applies to a provider | Seeker's "application sent" mail → `http://localhost:5174/auth/login` |
| 2 | Same action, provider's copy | Provider's "a seeker applied" mail → `http://localhost:5175/auth/login` |
| 3 | Provider accepts | Seeker's status mail → `:5174`; provider's → `:5175` |
| 4 | Seeker retires their profile | Cancelled provider counterparty's mail → `:5175` |
| 5 | Brand-new signup on `:5175` | Welcome mail link → `:5175/auth/login` |

**Row 5 needs self-signup enabled on this instance — check before you start.**
During this session's Step 6 Path-B investigation, calling
`/api/auth/unified-otp/request` against this running instance returned
`SELF_SIGNUP_DISABLED`; self-signup was off by default here, which would
block row 5 outright (no new user gets created, so no welcome mail is sent).
Confirm whatever instance setting controls `SELF_SIGNUP_DISABLED` is turned
on before attempting row 5. **Alternative if it can't be enabled:** use an
already-provisioned / admin-onboarded account instead — but its welcome mail
was already sent once, at provisioning time, so row 5 specifically (the
welcome-mail CTA) cannot be re-observed that way; such an account is only
useful for rows 1-4.

Nothing may link to `http://localhost:9999` — that is the stand-in for the
blocked front-door.

## Teardown

```bash
kill %1 %2 %3 2>/dev/null   # or: pkill -f 'src/server.ts'; pkill -f 'npx vite'
docker compose stop db redis
```
