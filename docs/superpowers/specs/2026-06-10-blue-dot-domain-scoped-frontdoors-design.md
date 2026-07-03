# blue_dot — 6 Domain-Scoped Front-Doors over One Network / API / Postgres

> **Status:** Design (brainstormed 2026-06-10)
> **Scope:** signals-dpg (`network.json` contract + `apps/ui` + helm/deploy). Aggregator-dpg unaffected beyond "one deployment per network".
> **Tracking issue:** Blue-Dots-Economy/Signals-DPG#116
> **Builds on:** `feature` branch (participant onboarding lifecycle #104). Related: single-domain lock (`refactor/single-domain-lock`), connect-flow consent (`2026-05-31-connect-flow-consent-design.md`).

---

## 1. Problem

We want one jobs network (`blue_dot`) presented through several **role- and geography-specific URLs**:

- `seekers-signals.…`, `ka-seekers-signals.…`, `up-seekers-signals.…`
- `providers-signals.…`, `ka-providers-signals.…`, `up-providers-signals.…`

Each URL must (a) let a visitor create **only** its kind of profile, (b) let them discover **only** the counterpart kinds they're allowed to interact with, (c) let them connect **only** along the allowed matrix, and (d) when the **same phone** logs in, surface that account's one corresponding profile.

Constraint set by product: **single API backend + single Postgres** serving all six. Geography must **not** become a `network/domain/region` schema axis.

## 2. Goals

- Model geography as **domain identity**: 6 domains inside one `blue_dot` network.
- Encode the interaction matrix declaratively in `network.json` `actions{}` so **connect** is hard-enforced server-side with zero new code.
- Scope **create** and **discover** per front-door at the UI layer (the single-API limitation, §6).
- One phone ⇒ one profile (single-domain lock), shown on whichever front-door matches its domain.
- Keep deployment to **1 API + 1 PG + 1 Redis**, and ideally **1 UI** Deployment.

## 3. Non-goals

- A `network/domain/region` schema field (explicitly rejected).
- Hard, server-side per-URL **create** enforcement (impossible with one shared API; see §6 limitation).
- Splitting seeker vs provider data into separate Postgres instances (single PG by requirement).
- Aggregator-dpg changes beyond the existing "one deployment per network, multi-tenant by `aggregator_id`" model.

## 4. Domain model

One network, `id: "blue_dot"`, with six domains:

| domain id | item schema | notes |
|---|---|---|
| `seekers` | `profile_1.0` | national seeker |
| `ka-seekers` | `profile_1.0` | Karnataka seeker |
| `up-seekers` | `profile_1.0` | Uttar Pradesh seeker |
| `providers` | `job_posting_1.0` | national provider |
| `ka-providers` | `job_posting_1.0` | Karnataka provider |
| `up-providers` | `job_posting_1.0` | Uttar Pradesh provider |

Seeker variants share an identical `profile_1.0` JSON Schema; provider variants share `job_posting_1.0`. They are distinct domain entries that happen to carry the same schema (optionally DRY via `default_item_schemas`). Each domain keeps its own `status_rules`, `card`, and `dashboard_tiles`.

## 5. Interaction matrix → `actions{}`

Ten ordered pairs. National seekers/providers are cross-region; `ka`/`up` are region-locked.

| from_domain | to_domain(s) |
|---|---|
| `seekers` | `providers`, `ka-providers`, `up-providers` |
| `ka-seekers` | `ka-providers` |
| `up-seekers` | `up-providers` |
| `providers` | `seekers`, `ka-seekers`, `up-seekers` |
| `ka-providers` | `ka-seekers` |
| `up-providers` | `up-seekers` |

Each pair becomes one `actions.connect.interactions[]` entry:

```jsonc
"actions": {
  "connect": {
    "description": "Seeker and provider connect; region rules apply.",
    "interactions": [
      { "from_domain": "seekers",      "to_domain": "providers",     "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "seekers",      "to_domain": "ka-providers",  "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "seekers",      "to_domain": "up-providers",  "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "ka-seekers",   "to_domain": "ka-providers",  "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "up-seekers",   "to_domain": "up-providers",  "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "providers",    "to_domain": "seekers",       "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "providers",    "to_domain": "ka-seekers",    "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "providers",    "to_domain": "up-seekers",    "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "ka-providers", "to_domain": "ka-seekers",    "requirement_schema": { … }, "event_schema": { … } },
      { "from_domain": "up-providers", "to_domain": "up-seekers",    "requirement_schema": { … }, "event_schema": { … } }
    ]
  }
}
```

> If seeker→provider ("apply") and provider→seeker ("invite") deserve different PII-reveal/consent semantics, split into two action types (`apply`, `invite`) with the respective rows. Same matrix.

## 6. Enforcement model (verified against current code)

| Flow | Per-URL limit | Mechanism |
|---|---|---|
| **Connect** | ✅ **Hard, server-side, free** | `apps/api/src/routes/v1/action/perform_action.ts` → `getActionInteraction()` (`packages/schemas/src/network_workflow.ts`) does a strict 4-tuple match (`from_network/from_domain → to_network/to_domain`). Unlisted pair → `INVALID_ACTION_REQUEST`. Holds even against direct API calls. Network-action target instance re-validates (`routes/v1/network/action/perform_action.ts`). UI connect buttons derive from the same matrix (`getActionsForDomain`, `home-page.tsx`). |
| **Create** | ⚠️ **Soft (UI) + hard floor** | One API has one process-wide `SERVED_DOMAINS` (all 6) — `served_domain_guard` cannot distinguish hostnames. UI pins the create domain for new users. The **single-domain lock** (`apps/api/src/routes/v1/item/create_item.ts` + `resolve_domain_lock.ts`, per *user × network*) is the hard floor: a phone's first create binds it; a second create in another of the 6 domains → `403 DOMAIN_LOCKED`. Admin api-key callers bypass. |
| **Discover** | ⚠️ **Soft (UI)** | `home-page.tsx` `visibleDomains` currently lists *all* `to_domain`s network-wide, independent of the active profile. Needs a filter to the active domain's allowed targets. |

### Accepted limitation

Hard, server-side **create** scoping per URL is **not achievable with a single shared API** (it would require separate API processes each with a narrow `SERVED_DOMAINS`, contradicting the single-backend requirement). The single-domain lock still guarantees every user ends up in exactly one of the six buckets — only the *choice* of bucket for a brand-new account is UI-driven (soft).

## 7. Identity & "same phone → corresponding profile"

- Phone normalized to E.164; one account in the shared API/PG regardless of which of the 6 hostnames is used (all UIs hit the same API + auth DB).
- Single-domain lock ⇒ at most one profile per account in `blue_dot`. On login the UI fetches `created_by_me` across all 6 domains and selects the one held profile.
- **Decision:** when a phone whose locked domain differs from the front-door it logged into is detected, **redirect to that domain's home front-door** (a `domain → URL` map in UI config). New visitors → become this front-door's domain; existing users of another domain → bounced home.

## 8. Deployment / k8s topology

- **1** `dpg-api` Deployment + Service. `SERVED_DOMAINS="blue_dot/seekers,blue_dot/ka-seekers,blue_dot/up-seekers,blue_dot/providers,blue_dot/ka-providers,blue_dot/up-providers"`, one `NETWORK_CONFIG_LOCAL_FILE`.
- **1** Postgres, **1** Redis.
- **UI (recommended):** make the UI **host-aware** — derive `pinnedDomain` / brand / discover-scope from `window.location.hostname` against a host→config map in a single `/config.js`. Then **1** UI Deployment + Service fronts all 6 hosts.
  - **Fallback** (today's static `/config.js` model, one config per pod): **6** UI Deployments + Services + ConfigMaps.
- **1** Ingress with 6 host rules; each host routes `/` → UI Service; each UI nginx reverse-proxies `/api/*` → the shared `dpg-api` Service (same-origin per `apps/ui/src/lib/api-config.ts`).
- **Aggregator:** **1** aggregator-dpg deployment per network (multi-tenant by `aggregator_id` / `signalstack_org_id`), not per front-door / org / geo.

## 9. Implementation plan

1. **`network.json`** — author the 6 domains (shared `profile_1.0` / `job_posting_1.0`, per-domain `status_rules` + `card` + `dashboard_tiles`) and the 10-row `actions.connect` block; validate against `NetworkConfigSchema`. Add Postman + an `examples/schemas/blue_dot_frontdoors/` (or extend existing `blue_dot`).
2. **UI #1 — host-aware runtime config:** extend `runtime-env.ts` / `/config.js` with a host→{domain, brand, discoverTargets} map; consume in `profile-form-page.tsx` to pin the domain and hide the role picker for new users. Enables the single-UI deployment (§8).
3. **UI #2 — discover filter:** narrow `home-page.tsx` `visibleDomains` to the active domain's allowed `to_domain`s.
4. **UI #3 — login redirect:** on session resolve, if the account's locked domain ≠ current host's domain, redirect to the locked domain's home front-door.
5. **Helm/deploy:** api values (`SERVED_DOMAINS` all 6); ui values (host-aware config map); Ingress with 6 host rules; single PG/Redis. Update `bluedots-automation` `helm/signals` accordingly.

Branch: `feat/blue-dot-domain-scoped-frontdoors` off `feature`; tasks land as commits, single rolling PR.
