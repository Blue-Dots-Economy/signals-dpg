# Bringing the local stack up

Read this when §0's probe says no stack is live, or one is live on the wrong
dot. It is self-contained: this skill does not depend on any other skill.

Everything below runs from the **repo root of the checkout that will run the
stack** — not necessarily the worktree this skill lives in. `SIGNALS_REPO`
names that checkout.

## Ports and containers

API `:2742` · UI `:3000` **or** `:5173` (branch-dependent — probe, never
assume) · Postgres `:5432` (container `dpg-db`) · Redis (container
`dpg-redis`).

## Which dot?

The path uses the **directory** name; `SERVED_DOMAINS` and `VITE_NETWORK_ID`
use the network **id** from `network.json`. They are not always the same:

| Directory | Network id | Domains |
|---|---|---|
| `blue_dot` | `blue_dot` | seeker, provider |
| `purple_dot` | `purple_dot` | seeker, provider |
| `orange_dot` | `orange_dot` | practitioner |
| `yellow_dot` | **`onest_yellow_dot`** ⚠️ id ≠ directory | student, individual_tutor_weera_counsellor |

The block below derives the id automatically — only choose the directory.
`blue_dot` is this skill's default: it is the only dot with both `apply` and
`connect`, a U18-gated seeker, and a brand skin.

## The block

Fill in `NET_DIR`, then run the whole thing in one shell.

```bash
# ===== set this =====
NET_DIR="blue_dot"     # blue_dot | purple_dot | orange_dot | yellow_dot
# ====================
cd "${SIGNALS_REPO:?set SIGNALS_REPO to the checkout that runs the stack}"
source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 24 >/dev/null 2>&1

CFG="examples/schemas/$NET_DIR/network.json"
[ -f "$CFG" ] || { echo "No network at $CFG. Available: $(ls examples/schemas)"; exit 1; }
NET_ID=$(node -e "console.log(require('./$CFG').id)")
DOMAINS=$(node -e "console.log(require('./$CFG').domains.map(d=>d.id).join(','))")
SERVED=$(node -e "console.log('$DOMAINS'.split(',').map(s=>s.trim()).filter(Boolean).map(d=>'$NET_ID/'+d).join(','))")
echo "▶ network=$NET_ID  served=$SERVED"

# 1) Env. Idempotent (delete + append).
#
#    ⚠️ BLANK-UI GOTCHA #1 — the network id lives in TWO files. The turbo
#    wrapper (scripts/turbo-with-root-env.mjs) injects root .env into Vite, and
#    Vite gives that injected value PRECEDENCE over apps/ui/.env. A stale
#    VITE_NETWORK_ID in root .env silently overrides the UI, which then resolves
#    the wrong network, 404s on fetchNetworkConfig, and renders blank — even in
#    incognito, and `?network=` will not fix it. Set BOTH. Same for
#    VITE_SERVED_BINDINGS, or the UI serves the wrong domains.
sed -i '' '/^SERVED_DOMAINS=/d' .env; printf 'SERVED_DOMAINS="%s"\n' "$SERVED" >> .env
sed -i '' '/^NETWORK_CONFIG_LOCAL_FILE=/d' .env
printf 'NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/%s/network.json"\n' "$NET_DIR" >> .env
for k in VITE_NETWORK_ID VITE_SERVED_BINDINGS VITE_DEFAULT_NETWORK_THEME; do sed -i '' "/^$k=/d" .env; done
printf 'VITE_NETWORK_ID=%s\nVITE_SERVED_BINDINGS=%s\nVITE_DEFAULT_NETWORK_THEME=%s\n' "$NET_ID" "$SERVED" "$NET_ID" >> .env

touch apps/ui/.env
for k in VITE_NETWORK_ID VITE_SERVED_BINDINGS VITE_DEFAULT_NETWORK_THEME VITE_DEFAULT_BRAND; do sed -i '' "/^$k=/d" apps/ui/.env; done
printf 'VITE_NETWORK_ID=%s\nVITE_SERVED_BINDINGS=%s\nVITE_DEFAULT_NETWORK_THEME=%s\nVITE_DEFAULT_BRAND=standard\n' "$NET_ID" "$SERVED" "$NET_ID" >> apps/ui/.env

#    ⚠️ BLANK-UI GOTCHA #2 — VITE_API_URL. A .env copied from another checkout
#    often carries a stale LAN IP, unreachable now, so the UI's first fetch
#    (/network/schemas) fails and it hangs on its loading skeleton — which looks
#    blank/white in dark mode, with nothing in the console. Force both files to
#    localhost; root wins, so both must agree.
for f in .env apps/ui/.env; do sed -i '' '/^VITE_API_URL=/d' "$f"; printf 'VITE_API_URL=http://localhost:2742\n' >> "$f"; done

# 2) E2E-ONLY ENV — this is what separates a stack that can be tested from one
#    that merely runs. Without these the suite skips silently or asserts against
#    an empty inbox.
#      CREATE_TEST_OTP        every OTP becomes "000000", so login and guardian
#                             flows run unattended. Boot FAILS if this is ever
#                             set with INSTANCE_ENV=production — by design.
#      SELF_SIGNUP_MODE       'allowed', or the suite cannot create its personas.
#      NOTIFICATION_SERVICE_* ALL THREE, or getNotificationClient() returns
#                             undefined and the API sends NOTHING while looking
#                             healthy (apps/api/src/utils/notificationClient.ts).
#                             The sink ignores HMAC, so the key/secret are dummies.
for k in CREATE_TEST_OTP SELF_SIGNUP_MODE NOTIFICATION_SERVICE_ENDPOINT NOTIFICATION_SERVICE_KEY_ID NOTIFICATION_SERVICE_SECRET; do
  sed -i '' "/^$k=/d" .env
done
cat >> .env <<'ENVEOF'
CREATE_TEST_OTP=true
SELF_SIGNUP_MODE=allowed
NOTIFICATION_SERVICE_ENDPOINT=http://localhost:4545
NOTIFICATION_SERVICE_KEY_ID=e2e-local
NOTIFICATION_SERVICE_SECRET=e2e-local-sink-ignores-hmac
ENVEOF

# 3) Infra
docker compose up -d db redis >/dev/null 2>&1
for i in $(seq 1 20); do docker exec dpg-db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
PGUSER=$(sed -n 's/^POSTGRES_USER=//p' .env | tr -d '"' | head -1)
PGDB=$(sed -n 's/^POSTGRES_DB=//p' .env | tr -d '"' | head -1)
REDISPW=$(sed -n 's/^REDIS_PASSWORD=//p' .env | tr -d '"' | head -1)

# 4) Schema — idempotent; adds columns added since this DB was created.
docker exec -i dpg-db psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 < apps/api/db/postgres/schema.sql >/dev/null 2>&1

# 5) Caches. The network-schema cache MUST go on a dot change or the UI serves a
#    stale/empty config and renders blank.
find /var/folders /private/var/folders /tmp -maxdepth 5 -type d -name 'dpg-network-schema-cache' -exec rm -rf {} + 2>/dev/null
[ -n "$REDISPW" ] && docker exec dpg-redis redis-cli -a "$REDISPW" --no-auth-warning \
  EVAL "local k=redis.call('keys','item-*'); for i=1,#k do redis.call('del',k[i]) end; return #k" 0 >/dev/null 2>&1

# 6) Stop anything already on those ports
lsof -nP -iTCP:2742 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | xargs kill 2>/dev/null
lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | xargs kill 2>/dev/null
ps -Ao pid,command | grep -iE 'turbo.*filter=(api|ui)|tsx watch src/server|--import tsx src/server.ts' | grep -v grep | awk '{print $1}' | xargs kill 2>/dev/null
sleep 2

# 7) Start.
#    ⚠️ The API must be a DIRECT node launch reading root .env. `pnpm dev:api`
#    spawns through turbo, which keeps a schema cache in a tmpdir step 5 cannot
#    reach — so /network/schemas returns empty and the UI goes blank. No
#    tsx-watch here either: re-run this block after API code changes.
( cd apps/api && nohup node --env-file=../../.env --import tsx src/server.ts > /tmp/signals-api.log 2>&1 & )
UICMD="dev:ui"; [ "$NET_DIR" = "orange_dot" ] && UICMD="dev:tourist"   # orange_dot is the tourist app
nohup pnpm "$UICMD" > /tmp/signals-ui.log 2>&1 &

# 8) Verify. A zero schema count means the UI WILL be blank — do not proceed.
for i in $(seq 1 40); do curl -sf "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" >/dev/null 2>&1 && break; sleep 1; done
echo -n "config: "; curl -s "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const n=JSON.parse(d).length;console.log(n+" entries "+(n>0?"(OK)":"(❌ EMPTY → UI will be blank)"))}catch(e){console.log("0 (❌)")}})'
for p in 3000 5173; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$p/" 2>/dev/null)
  [ "$code" = "200" ] && echo "ui:     http://localhost:$p"
done
echo "logs:   /tmp/signals-api.log  /tmp/signals-ui.log"
```

## If it does not come up

- **`config: 0 entries`** → the schema cache was not cleared, or the API is
  turbo-spawned rather than the direct launch in step 7. Both produce an empty
  `/network/schemas` and a blank UI. Re-run from step 5.
- **No UI on either port** → read `/tmp/signals-ui.log` for the port Vite chose.
- **Wrong dot served** → `SERVED_DOMAINS` / `NETWORK_CONFIG_LOCAL_FILE` did not
  take, or the API is reading a different `.env`. Kill it and re-run.
- **Reading `.env` may be permission-blocked** in some environments; use
  `node -e` to inspect it rather than `cat`/`grep`.

## Note

Steps 1–8 are adapted from a personal `run-signals-dpg` skill that is not part
of this repo. If you have that skill, it does the same job and you may use it
instead — this file exists so the e2e skill never depends on it.
