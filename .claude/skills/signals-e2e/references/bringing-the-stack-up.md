# Bringing the local stack up

Read this when §0's probe says no stack is live, or one is live on the wrong
dot. It is self-contained: this skill does not depend on any other skill.

**This used to be a ~60-line shell block meant to be hand-transcribed into a
shell by whichever agent was running this skill.** It is now a real,
executable script — `lib/bring-stack-up.sh` — so that duplication (and the
inevitable drift between "the doc" and "what actually ran") can't happen
again. `lib/run.sh` calls it automatically the moment its own quick probe
finds nothing already answering for the requested dot; you do not need to run
it by hand as part of the normal `/signals-e2e` flow. This file exists for
the two cases where you *do* want to run it directly:

- Bringing a stack up **without** running the suite yet (e.g. to poke around
  in the UI first).
- Debugging a cold-start failure in isolation, one gotcha at a time.

## Running it directly

```bash
# from anywhere; SIGNALS_REPO only needed if the checkout that runs the stack
# isn't this worktree's own repo root (see the script's header for the same
# fallback-to-main-checkout logic stack-up.sh uses)
bash .claude/skills/signals-e2e/lib/bring-stack-up.sh blue_dot
# blue_dot | purple_dot | orange_dot | yellow_dot — directory name, not
# necessarily the network id (see the table below)
```

It brings up `db`/`redis`, applies the (idempotent) schema, clears the caches
that must be cleared on a dot switch, starts the API (a direct `node` launch,
never `pnpm dev:api` — see the script's own step-7 comment for why) and the
UI, and prints a `ready` summary with the API/UI URLs as its **last** output —
whether its own stdout is a terminal or a pipe. It exits non-zero, with a
`FAIL:` line naming what went wrong, if the target never becomes reachable.

`lib/stack-up.sh` still does its own, separate job afterward (verify, probe
UI identity, read capability env, write this run's `env.sh`/marker) — bringing
the stack up and verifying it are two different concerns, and `run.sh` chains
them (bring-up only when needed, verify always) rather than merging them into
one script.

## Which dot?

The path uses the **directory** name; `SERVED_DOMAINS` and `VITE_NETWORK_ID`
use the network **id** from `network.json`. They are not always the same:

| Directory | Network id | Domains |
|---|---|---|
| `blue_dot` | `blue_dot` | seeker, provider |
| `purple_dot` | `purple_dot` | seeker, provider |
| `orange_dot` | `orange_dot` | practitioner |
| `yellow_dot` | **`onest_yellow_dot`** ⚠️ id ≠ directory | student, individual_tutor_weera_counsellor |

The script derives the id automatically — only choose the directory.
`blue_dot` is this skill's default: it is the only dot with both `apply` and
`connect`, a U18-gated seeker, and a brand skin.

## Ports and containers

API `:2742` · UI `:3000` **or** `:5173` (branch-dependent — the script probes
both and verifies identity, never assumes) · Postgres `:5432` (container
`dpg-db`) · Redis (container `dpg-redis`).

## The gotchas the script encodes

Read `lib/bring-stack-up.sh` itself for the full comments — summarized here
so this file is still useful as an index:

- **Blank-UI gotcha #1** — the network id lives in root `.env` AND
  `apps/ui/.env`; Vite gives the root-injected value precedence, so a stale
  one silently overrides the UI even in incognito. The script sets both.
- **Blank-UI gotcha #2** — `VITE_API_URL` copied from another checkout often
  carries a stale LAN IP. The script forces both files to `localhost`.
- **The schema cache must be cleared on a dot switch**, or `/network/schemas`
  serves a stale/empty config.
- **The API must be a direct `node` launch**, never `pnpm dev:api` (turbo
  keeps a schema cache the clear step can't reach) — and never `tsx watch`
  either (re-run the script after an API code change).
- **A port that answers isn't necessarily Signals'.** On at least one real
  machine, `:3000` was the *Blue Dots aggregator* portal (Next.js), a
  different product — an earlier version of this recipe killed it
  unconditionally. The script now identifies whatever is listening before
  touching it (the same `/src/main.tsx` marker `stack-up.sh` uses for the UI,
  plus a schema-shaped-response check for the API) and refuses to kill
  anything it can't positively identify as Signals' own — a required port
  (the API's) fails loudly instead; an optional one (the UI's primary port)
  is left alone and the UI falls back to its other port.
- **A backgrounded dev server must be FULLY detached — process LIFETIME
  first, output second.** A bare `&` leaves the API/UI as children of THIS
  SCRIPT'S OWN PROCESS GROUP: whatever reaps or signals that group (a CI step
  killed for exceeding its timeout, an agent harness tearing down a
  backgrounded invocation, Ctrl-C at a real terminal) takes the dev servers
  down WITH it, silently, mid-run, with nothing in either server's own log
  explaining why. `disown` alone does not fix this — it only stops bash's job
  table from `wait`-ing on the child or forwarding SIGHUP; the child stays in
  the same process group either way. The script's `spawn_detached` helper
  fixes it via Node's `child_process.spawn({ detached: true })` (`setsid()`
  under the hood — a new session, no shell job control involved). Bash's own
  `set -m` looks like an equally plausible fix (it also gives a backgrounded
  job its own process group) and was tried first; it does NOT work here —
  confirmed live, it hangs the launching shell indefinitely the moment there
  is no controlling terminal at all, which is exactly what this skill's own
  documented automation shape (`nohup bash lib/run.sh ... &`) produces. The
  *other*, previously-reported symptom of the same gap is an output problem,
  not a lifetime one: each child's stdout/stderr must go straight to its own
  log file, never inherited — a script that let a dev server share the
  caller's own stdout once saw its "ready" summary sit unprinted for ~25
  minutes because of exactly that.

## If it does not come up

- **`config: 0 entries`** in the script's own output → the schema cache was
  not cleared, or the API is turbo-spawned rather than the direct launch.
  Both produce an empty `/network/schemas` and a blank UI.
- **No UI on either port** → read `/tmp/signals-ui.log` for the port Vite
  chose (or why it didn't start).
- **`FAIL: :2742 is ... occupied by an unidentified process`** → something
  else is bound to the API's port; stop it yourself (the script will not).
- **Wrong dot served** → `SERVED_DOMAINS` / `NETWORK_CONFIG_LOCAL_FILE` did
  not take, or the API is reading a different `.env`. Re-run the script.
- **Reading `.env` may be permission-blocked** in some environments; use
  `node -e` to inspect it rather than `cat`/`grep` (every reader in these
  scripts already does this).

## Note

This script is adapted from a personal `run-signals-dpg` skill that is not
part of this repo. If you have that skill, it does the same job and you may
use it instead — this script exists so the e2e skill never depends on it.
