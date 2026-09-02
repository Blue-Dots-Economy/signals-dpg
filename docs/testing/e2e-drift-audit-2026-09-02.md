# E2E suite drift audit — what a month of `feature` did to the lifted suite

**Dated:** 2026-09-02 · **Branch:** `feat/signals-e2e-skill`

The suite in `e2e/` was lifted from `functional-testing-automation`. That branch
diverged from `feature` at **`ad0f1155` (2026-08-03)** and its last commit was
2026-08-10. **132 non-merge commits** have landed on `feature` since the
divergence point.

This audit separates what is *broken*, what is *stale*, and what is *missing*.
Everything below was measured on the current tree, not inferred from commit
messages.

---

## 1. Broken — will fail or silently mis-assert today

### 1.1 The consent scroll-gate uses `aria-disabled`, not `disabled` (#636, `65b18c39`)

`apps/ui/src/components/consent/consent-gate.tsx:58` is explicit that this is
deliberate:

> report it via `aria-disabled` AND guard their handler on it — they are
> deliberately not `disabled`, which would drop them out of the [tab order]

Playwright's actionability check waits on the **real `disabled` attribute**. So
`click('Accept & Continue')` on an ungated modal **lands, the handler no-ops,
and the failure surfaces later** as a confusing downstream assertion error
rather than at the click.

Any spec that passes through the consent gate is affected. The fix is to scroll
each document's inner scroll region to its end (and tick through both the
Privacy and Terms tabs) before ticking the checkbox — the same trap the
`aggregator-e2e` skill documents.

**Severity: high.** Misleading failure, not a clean one.

### 1.2 `domainLabelFromKey` no longer mirrors the UI (`cbbc1959`)

`e2e/src/ui.ts:21` title-cases the domain id. The UI now prefers
`network.json`'s `label` (`apps/ui/src/lib/domain-icons.ts:57`, `formatDomainLabel`),
falling back to title-case.

Measured across the dots:

| Dot | domain | `network.json` label | e2e mirror | agree? |
|---|---|---|---|---|
| purple_dot | provider | **Service Provider** | Provider | **no** |
| purple_dot | seeker | (none) | Seeker | yes |
| blue_dot | seeker, provider | (none) | Seeker / Provider | yes |
| orange_dot | practitioner | (none) | Practitioner | yes |
| yellow_dot | both | (none) | title-cased | yes |

So it passes on `blue_dot` — the configured default — and **fails on
`purple_dot` today**. This also violates the suite's own rule ("assert
behaviour, not payload shape; resolve via `schema.ts`"): the label should be
read from the resolved network config, not re-derived.

**Severity: medium** (latent on the default dot, live on purple_dot).

### 1.3 `uiBaseUrl` points at the wrong port

`e2e/config/local.json` has `http://localhost:5173`; `/run-signals-dpg` serves
the UI on `:3000`. Every UI spec fails on connection-refused before asserting
anything. Resolve by probing both at run time — the skill's own notes record
that some branches genuinely do use Vite's default.

**Severity: high**, trivially fixed.

### 1.4 One route has no journey

`npm run coverage` on `feature`: **33/53 operations (62%)**, exit 1, one
unmapped route — `GET /api/v1/support/config`, which landed with the
support-attachments work (#551/#552, `b9a8b5e8`) after the branch went dormant.
The gate caught this on first contact, which is the gate working.

---

## 2. Stale — assumptions that no longer describe the product

### 2.1 "signals-search cannot be run locally" is no longer true (#625, `ee7e498d`)

`apps/api/src/services/signals_search_client.ts:8` still says it, and the
design spec quoted it. As of 2026-08-27 `local-setup/docker-compose.yml` has a
`search` profile: `signals-search-api` (:3100), the ingestion worker, and a TEI
embedding server with `BAAI/bge-m3` baked in.

**But it is not usable on this machine.** The images are `platform:
linux/amd64` and the host is arm64 with 8 GB of RAM; the compose header notes
the embedder alone wants 3–8 GB for a ~2.3 GB ONNX model. Under emulation on
8 GB that will thrash — consistent with the existing note about capping test
concurrency here.

**Consequence for the design:** the stub stays the default, but it is now a
*choice*, not a workaround, and the real profile becomes an opt-in
fidelity mode. The stub also keeps two things the real service cannot easily
give: the fault-injection modes (`down` / `slow` / `anchor-not-found`) that
backlog §2.1 #6 asks for, and the request-envelope recorder.

### 2.2 Go-live semantics became config-driven (#344, `309b7892`)

`go_live_required` per domain replaced the implicit "every network is
consent-gated" rule. `e2e/src/flows.ts` survives this by accident rather than
design — it posts consent and then *polls* for `live`, throwing with a clear
message if it never arrives. Robust, but it no longer asserts the actual gate
set; a domain configured `schema_required`-only would pass for the wrong
reason.

### 2.3 Keycloak is on `feature` now (`af113404`)

The suite's Keycloak harness (`src/keycloak.ts`, `keycloak_log.ts`, the
dual-mode auth) is **not dead code** — the IAM epic landed on `feature`,
dormant behind `AUTH_PROVIDER=betterauth`. `authProvider: "auto"` in the config
is therefore correct and worth keeping.

### 2.4 Dependency majors crossed since divergence

`ioredis` 5→6 (`08b2bbaf`), `jose` 5→6 (`edc681e5`), `react-markdown` 9→10
(`3997678a`), plus a 37-package production bump (`a4d5488f`). None of these are
asserted by the suite; they are listed because a behavioural regression from
them would surface as an unexplained e2e failure.

---

## 3. Missing — features that postdate the branch with no coverage

Grouped by area, with the commit that introduced each.

### 3.1 Notifications — the largest gap

**The entire current notification subsystem postdates the branch.** The suite
has zero email assertions, and the capability behind them
(`notificationStub`) is declared with no implementation.

| Feature | Commit |
|---|---|
| Externalised email copy + single dispatcher (#529/#540) | `23d86c4f` |
| Per-domain email CTA (#569/#602) | `43f5b9ce` |
| Item-lifecycle + aggregator-onboarding emails (#531/#534/#592) | `5db2d908` |
| SMS template engine, Phase 1 (#532/#535/#595) | `fac98753` |
| Per-domain self-signup welcome + provider copy | `4261d28c`, `68d04a75` |
| Per-domain aggregator-onboarding activation email | `54a5b9a7` |
| Email styling; purple_dot ALIMCO connect wording (#555/#556) | `449a9097`, `1a3ff106` |

Present inventory: **35 email cases + 5 SMS cases**, every one reachable in a
local run.

### 3.2 Lifecycle and the search index

- **Publish an item event on every lifecycle transition (#557/#564)**,
  `95fe484e` — precisely the bug the ingest-stream stub exists to catch. With
  `item_search` empty the API silently falls back to `items.item_locations`, so
  a missing event passes every assertion today.
- Map bbox fallback to `items.item_locations` (#503), `367459b7`.

### 3.3 Profile form and schema markers

| Feature | Commit |
|---|---|
| Config-driven per-domain go-live gates (#344) | `309b7892` |
| `x-uri` field marker + URL validation (#576) | `da9ec9b8` |
| Clearable + keyboard-navigable dropdowns, OTP subtitle (#648) | `500d4465` |
| First-time-login redirect + in-shell form + inline consent (#376/#478) | `bd116764` |
| Select the newly created profile as active (#472) | `91f15ac5` |
| View-profile modal scroll; left-aligned select text (#507/#599) | `21020495` |
| `x-reference-source` colleges datasets (#606) | `a40a5e9c`, `ebc1fe41` |

### 3.4 Share / public profile

Shareable profile links + public profile page (#476/#481), `def4fe0c`;
downloadable QR (#567/#612), `02b092f0`. **No coverage at all.**

### 3.5 My Actions

Per-profile filter & sort, PII-aware and server-enforced (#439/#483),
`43e1677e`. **No coverage at all.**

### 3.6 Map

Self-action guard — never show or allow an action on your own profile
(`fe5d7abd`, `50356a4e`); world-zoom viewports returned no markers
(`29bda865`); out-of-range viewport bounds clamped, errors no longer reported
as empty (`8da77e48`); domain icons (#459), `d9d6c99a`.

### 3.7 Consent and legal

Scroll-gate (#636) — see §1.1; one `/legal` route with `/privacy` and `/terms`
as redirects (#637), `500d4465`; consent markdown nested links and tables
(#588), `bf40ce9c`.

### 3.8 Support

Attachments, max 5 MB configurable (#551/#552), `b9a8b5e8`; `/support/config`
— see §1.4.

### 3.9 Participant / admin

Participant-decrypt field projection + contact block + locations (#521/#522),
`75f44255`.

### 3.10 Brand and runtime config

Lockup logos and the configurable sidebar-footer logo (#605); `up-gzb` and
`ka-dhwd` brands; per-deployment settings routed through `getRuntimeEnv`
(`05954e10`); EkStep footer on the network default only (`8704ec73`).

---

## 4. What this changes in the design

1. **Fix §1 before adding anything.** Four defects, all small, and until they
   are fixed no UI result from this suite means anything.
2. **Point 2.1 makes the search stub a documented choice**, with the real
   `--profile search` as an opt-in `realSearch` capability for a fidelity run
   on a machine that can host it.
3. **§3 is the coverage backlog for this work**, and it maps onto the suites in
   the design spec rather than replacing them. §3.1 and §3.2 are the highest
   value: both are subsystems whose defining bug class is *silence*, so they
   cannot be caught by reading the code or by a suite that does not assert
   them.
4. **`coverage.md` must enumerate more than routes.** Route coverage was 62%
   while the whole notification subsystem, the share page and My Actions
   filtering had no coverage at all — none of which is a route the gate could
   have noticed. That is the argument for extending the check to UI routes,
   email cases, SMS cases and schema markers.

## 5. How this was measured

```bash
MB=$(git merge-base origin/functional-testing-automation origin/feature)
git log --oneline --no-merges $MB..origin/feature      # 132 commits
cd e2e && npm run typecheck                            # clean
cd e2e && npm run coverage                             # 33/53, exit 1
```

Selector drift was checked by extracting every `getByRole`/`getByLabel`/
`getByText` argument from `e2e/tests/ui` and `e2e/src/ui.ts` and comparing each
against `apps/ui/src/i18n/locales/en.json` and the component that renders it.

**Not yet done: running the suite against a live stack.** Everything above is
static analysis. A live run is the only way to find drift that static reading
misses, and it is the first step of implementation.
