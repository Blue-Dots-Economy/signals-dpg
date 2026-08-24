# Per-domain email CTA — design

Issue: [#569](https://github.com/Blue-Dots-Economy/signals-dpg/issues/569)
Date: 2026-08-24
Status: approved, ready for planning

## Problem

Every email link the API emits points at one process-wide host. Now that seeker
and provider are served by separate UIs on separate domains, that host is the
retired combined front-door — which is blocked at the UI — so every link is
dead for every recipient.

The host comes from `FRONTEND_BASE_URL`, a single optional scalar
(`packages/config/src/secrets.ts:262`), which infra fills from
`https://${signals_public_hosts[0]}`
(`bluedots-automation/opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl:48`).
"First host in the list wins" was correct while a release had one front-door and
is arbitrary once it serves several.

This cannot be fixed by repointing that scalar: one API process serves all
domains (#116), so pointing it at the seeker portal merely sends providers to
the seeker portal instead.

## Scope

The rule: **re-point links that already exist. Do not change any email template,
and do not add a link to any mail that does not have one today.**

Applying that rule to the actual copy files rather than to the issue's prose
changes the scope in both directions.

### In scope

| Mail | Link today | Recipient's domain comes from |
|---|---|---|
| Action: apply/connect sent + received, status updates | `renderCtaShell` — CTA button + "Or open this link:" | `NotificationPlan.recipientDomain` |
| Retire cancellation (#418) | same shell, same `ctaUrl` | `RetireCancelledCounterparty.domain` |
| Welcome | `{{siteLink}}` in `welcome.body` for `blue_dot` + `purple_dot` | the signup-form domain, already read in `provisioning.ts` |

### Out of scope, with reasons

- **Login OTP.** On a Keycloak deployment the OTP mail is rendered by
  Keycloak's own theme (`infra/keycloak/themes/otp/email/messages/messages_en.properties`)
  and contains **no link at all** — only the code. Adding one is precisely what
  the scope rule forbids. The API-side `login.otp` copy does render
  `{{siteLink}}` (blue_dot, purple_dot) — but only under
  `AUTH_PROVIDER=betterauth`, and these deployments run `keycloak`, where those
  routes are unmounted (`app.ts:288`). So there is nothing to re-point on the
  live path. Fixing the betterauth path would additionally cost an interface
  change in `packages/auth` to carry a domain into `sendEmailOtp`, for a code
  path these deployments never execute.

  **Caveat, stated rather than buried:** `betterauth` is the *default* value of
  `AUTH_PROVIDER`, not a dead setting. Any deployment left on the default and
  using blue_dot/purple_dot copy will keep rendering a dead `{{siteLink}}` in
  its login-OTP mail after this change. That is accepted because the deployments
  in question run Keycloak; it should be noted on the issue so the trade-off is
  a recorded decision rather than an oversight.
- **Support email subject** (`config.ts:168` → `submit_support.ts:172`, the
  `from <site>` fragment). A subject-line string, not a body link.
- **`API_DOMAIN`** (`tfpl:47`) — the same `signals_public_hosts[0]` pattern, but
  a different concern with a different blast radius. Out of scope; worth its own
  issue.
- **Deep-linking the CTA to the specific action.** Unchanged from the issue:
  links still land on `/auth/login`, just on the right host. That is #188 item 7.

### Deliberately *not* needed

The issue proposes adding `recipientNetwork` to `NotificationPlan`. Because the
map is keyed by **domain alone** (below), that addition is unnecessary — one
deployment serves one network today (`_network` is a single scalar and
`NETWORK_CONFIG_LOCAL_FILE` names one file).

## Design

### 1. Config input: `UI_HOST_BINDINGS`

The API receives **the same string the UI already uses**, verbatim:

```
UI_HOST_BINDINGS=bluedotssignals.provider.org=purple_dot/provider;bluedotssignals.seeker.org=purple_dot/seeker
```

This is `_signals_host_bindings` from `global-values.yaml` — already the single
hand-edited source of truth, already emitted to `ui.hostBindings`, and already
used by the UI ingress to derive `VITE_SERVED_BINDINGS` **host → domain** per
request (`charts/ui/templates/ingress.yaml:12`). The API derives the inverse,
**domain → host**, from that same string. One value, two directions, nothing to
drift — which is the issue's sixth acceptance criterion, met by construction
rather than by a second list.

The inversion lives in TypeScript, not HCL, for two reasons: it is unit-testable
there, and a malformed entry can be skipped with a warning instead of failing
`tofu apply` at plan time with an index error.

Why not the aggregator's `SIGNALS_UI_URLS` (`domain=full-url`)? The aggregator is
an **external** app pointing at Signals, so it cannot know Signals' routes and
must be given whole URLs. Signals owns its own UI and already computes the route
itself (`buildCtaUrl` appends `/auth/login`). Baking full URLs into Signals' own
config would move a decision out of code that already makes it correctly.

New env in `packages/config/src/secrets.ts`, alongside `FRONTEND_BASE_URL`:

```ts
UI_HOST_BINDINGS: z.string().default(''),
```

### 2. Resolution module

New `apps/api/src/notifications/ui_urls.ts`:

- `parseUiHostBindings(raw): { byDomain: Record<string, string>, warnings: string[] }`
  - Split entries on `[;\n]`; split each on the **first** `=` only.
  - Host must be non-empty and contain no `/`; the binding must match the
    existing `network/domain` shape (`/^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/`,
    the same regex `parseServedDomains` uses, so the two agree on what a
    binding is).
  - Key by the **domain** segment; value `https://<host>`.
  - Never throws. A malformed entry is skipped with a warning — one typo must
    not take the API down over an optional feature.
  - **First host wins** on a duplicate domain (a vanity alias alongside the
    canonical host makes the inverse non-unique), with a warning naming the
    domain, because one of the two hosts is being discarded.
  - Ported from `aggregator-dpg`'s `parseSignalsUiUrls` (PR #653): same
    skip-and-warn posture, same `stripHelmQuoting` handling (which does not
    exist in this repo yet and must be ported too).
- `resolveCtaUrl(domain): string | undefined`
  1. `byDomain[domain]` → `buildCtaUrl(origin)`;
  2. else `FRONTEND_BASE_URL` → `buildCtaUrl(...)`;
  3. else `undefined`.

Scheme is assumed `https://` — host bindings carry bare FQDNs. Local dev sets no
host bindings and takes the `FRONTEND_BASE_URL` fallback, so this never bites
there.

**Boot-time cross-check.** Unlike the aggregator — whose domain list resolves
asynchronously, forcing it to defer this — Signals has `apiConfig.served_domains`
synchronously (`config.ts:33`). So a key naming no served domain (`seekr=`) is
warned about at boot. Log-only: a domain added to `network.json` ahead of the
ConfigMap rollout must not be able to switch a working link off.

### 3. Action + retire emails

- `dispatcher.ts`: `DispatcherDeps.brand.ctaUrl` becomes
  `resolveCtaUrl: (domain: string) => string`, called with
  `plan.recipientDomain`. This moves the URL out of the memoized `cachedConfig`
  and into a per-recipient lookup without touching plan building or the shell.
  `recipientDomain` is the **recipient's own** domain, not the counterparty's —
  the distinction that makes the seeker's "your application was sent" mail go to
  the seeker portal and the provider's "a seeker applied" mail to the provider
  portal.
- `notify_retire.ts`: `ctaUrl: resolveCtaUrl(cp.domain)`. No new plumbing —
  `RetireCancelledCounterparty` already carries `domain` and `network`.
- **Gate fix.** `resolveNotifierConfig` currently returns `null` — a hard no-op
  that sends *no action emails at all* — when `FRONTEND_BASE_URL` is unset
  (`notify_actions.ts:55`). It must become "scalar **or** a non-empty binding
  map", otherwise configuring only the new var silently stops every action
  email. This is a silent total outage, not a degraded link, so it needs its own
  test.

### 4. Welcome

`applySignupExtras` already reads the signup-form domain at `provisioning.ts:554`
and discards it. Return it, and pass it to `sendWelcomeNotifications`, whose
`siteUrl` becomes `resolveCtaUrl(domain)`.

The domain is available because of an existing chain: a split portal serves one
domain, so the signup form auto-selects it with no picker
(`keycloak-login-panel.tsx:184-197`); the local user row does not exist until
first login, so it is parked in Redis keyed by a hash of the identifier
(`services/auth/signup_extras.ts`); at first login `applySignupExtras` writes
`user.domains = [domain]` (`auth.ts:40` is a real `text[]` column). No request
plumbing and no extra query are needed.

`siteUrl` stays **omitted entirely** when unresolvable, so
`renderSiteLink(undefined)` keeps rendering the words "the platform" rather than
a dead `<a href="">`.

The other call site, `create_auth.ts:96`, is the better-auth path and is
unreachable under `AUTH_PROVIDER=keycloak`; it takes the same optional argument
for consistency but is not the path under test.

### 5. Infra (`bluedots-automation`)

One line. `signals_host_bindings` is **already** passed into the
`global_cloud_values` `templatefile(...)` map (`modules/output-file/main.tf:50`),
so no new tofu variable, no `variables.tf`, no `main.tf`, no
`_common/output-file.hcl` change:

```yaml
api:
  config:
    ...
    UI_HOST_BINDINGS: "${signals_host_bindings}"
```

Emitted unconditionally: the api chart's ConfigMap skips empty values
(`charts/api/templates/configmap.yaml:9`, `if ne ($val|toString) ""`) and the
deployment already does `envFrom: configMapRef`. So a single-host install renders
`""`, the key is dropped, and the API falls back to `FRONTEND_BASE_URL` exactly
as today. **No Helm chart changes.**

Plus one documentation row in `helm/README.md`: `_signals_host_bindings` now
also lands in `api.config.UI_HOST_BINDINGS`.

### 6. Also required

`turbo.json` has an env allowlist that already names `FRONTEND_BASE_URL`
(line 25). `UI_HOST_BINDINGS` must be added, or it will work locally and be
absent in a built image.

## Error handling

| Condition | Behaviour |
|---|---|
| Malformed entry in `UI_HOST_BINDINGS` | Skipped, warning at boot. Never fails boot. |
| Duplicate domain across two hosts | First wins, warning names the domain. |
| Key names no served domain | Warning at boot. Map used unchanged — never filtered. |
| Domain has no mapping | Falls back to `FRONTEND_BASE_URL`. |
| Neither map nor scalar set | Unchanged from today: action emails do not send; `siteUrl` is omitted from welcome. |

**Known limitation, accepted.** On a split deployment `FRONTEND_BASE_URL` is the
blocked combined front-door, so the fallback produces a link that does not work.
The fallback is kept anyway: the alternative for a CTA-shell mail is either
sending no email or changing the template, both worse. A missing mapping
therefore degrades to a broken link rather than an obviously broken config,
which the boot-time unknown-key warning only partly mitigates.

**Cosmetic, accepted.** In the welcome mail `{{siteLink}}` renders the URL as its
own visible link text, so it reads `https://signals-seeker…/auth/login`. Using
the bare origin would look tidier but relies on the origin redirecting a
logged-out user to login; verbatim is chosen for guaranteed correctness.

## Testing

- `parseUiHostBindings` table tests: well-formed multi-entry; malformed entry
  skipped with warning; duplicate domain first-wins with warning; empty input;
  Helm-quoted input; entry whose binding lacks a network prefix.
- `resolveCtaUrl` fallback matrix: map hit / map miss with scalar / map miss
  without scalar / neither.
- Dispatcher: a seeker-recipient plan resolves the seeker host and a
  provider-recipient plan the provider host **from the same event** — the test
  that would have caught keying off `counterpartyDomain`.
- Retire notifier: per-counterparty domain resolution.
- Welcome: resolves from the signup domain; omits `siteUrl` when unresolvable.
- Gate: a map-only configuration (no `FRONTEND_BASE_URL`) still sends action
  emails.
- Boot: unknown domain key warns and does not filter the map.

## Files

**Signals-DPG (9 + tests)**
`packages/config/src/secrets.ts`, `apps/api/src/config.ts`,
`apps/api/src/notifications/ui_urls.ts` (new),
`apps/api/src/notifications/notify_actions.ts`,
`apps/api/src/notifications/dispatcher.ts`,
`apps/api/src/notifications/notify_retire.ts`,
`apps/api/src/notifications/welcome.ts`,
`apps/api/src/services/auth/provisioning.ts`, `turbo.json`, plus tests.

**bluedots-automation (2)**
`opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl`,
`helm/README.md`.

## Acceptance criteria

Mapped to the issue's list:

- [ ] Seeker-facing action email CTA + fallback resolve to the seeker front-door.
- [ ] Provider-facing action email CTA + fallback resolve to the provider front-door.
- [ ] Welcome `{{siteLink}}` resolves to the recipient's front-door.
- [ ] ~~Login-OTP `{{siteUrl}}`~~ — dropped; see Scope. The live Keycloak OTP mail
      carries no link, and adding one violates the scope rule.
- [ ] A single-host install with only `FRONTEND_BASE_URL` behaves exactly as today.
- [ ] An unmapped domain falls back to `FRONTEND_BASE_URL` rather than emitting
      a dead `href=""`.
- [ ] The deployed value derives from `ui.hostBindings` — same string, not a
      second list.
