# Plan: replace better-auth with Keycloak — two providers, no feature gaps

**Status:** Draft for review
**Date:** 2026-07-31
**Scope:** `signals-dpg`. Implements the "Build 5" half that
`2026-07-23-keycloak-migration-design.md` defers (Builds 0–4 shipped in #423).
**Supersedes:** the earlier same-day draft `…-remove-better-auth-write-path.md`,
which scoped only the write path and assumed `dual` survived.

> Point-in-time record. Every claim below was verified against the code and a
> running local stack on 2026-07-31; file:line evidence is given inline. Where
> this plan and the code disagree later, the code wins.

---

## 1. The two inputs that shaped this revision

1. **No feature may be lost.** When `AUTH_PROVIDER=keycloak`, every behaviour the
   better-auth flow provides must have a Keycloak-path equivalent. §4 is the
   audit that makes this checkable rather than aspirational — and it found **7
   real gaps**, none of which the earlier draft accounted for.
2. **`dual` mode is removed.** `AUTH_PROVIDER` collapses to `betterauth |
   keycloak`. Under `keycloak`, better-auth is not involved in *any* step.

Input 1 is the reason this plan is mostly not about the write path. Input 2 has a
consequence that needs stating before anything else — see §2.1.

### A resolved worry: there is no U18 regression on the admin path

The prior draft's open question 3 asked whether replacing `signUpEmail` with a
direct insert would silently drop guardian materialization. **It would not.**

- `afterUserCreate` is a **`unifiedOtp` plugin option** (`packages/auth/src/config.ts:177`,
  inside the `unifiedOtp({…})` block), consumed at exactly one place:
  `packages/auth/plugins/unified_otp.ts:752`, and only `if (isNewUser)`.
- The `betterAuth({…})` call declares **no `databaseHooks`** — `grep -rn
  "databaseHooks"` returns zero hits repo-wide.
- `POST /api/v1/admin/participant` creates its user via
  `authInstance.api.signUpEmail` (`participant.ts:128`), which is not the OTP path.

So admin onboarding has **never** triggered guardian materialization, welcome
email, or welcome WhatsApp. The Keycloak path reproduces that exactly: the admin
route writes the row itself, so `provisionUserFromClaims` finds it and takes
`refreshMirror` (`provisioning.ts:206-222`), never `createMirror`.

**This is a pre-existing bug, not a migration regression** — an admin-onboarded
minor gets no `minor_guardian` row and no U18 consent rows. It is out of scope
here, but it is real and should get its own issue (open question 2).

---

## 2. The decision: two providers, not three

`AUTH_PROVIDER: z.enum(['betterauth', 'dual', 'keycloak'])`
(`packages/config/src/secrets.ts:51`) becomes
`z.enum(['betterauth', 'keycloak'])`, and the derived flags in
`apps/api/src/config.ts:66-67` become mutually exclusive:
`keycloak_enabled === !betterauth_enabled`.

### 2.1 What removing `dual` costs — read this first

**`dual` is the only thing keeping the straggler safety net alive.**
`backfillKeycloakShell` (`provisioning.ts:591-597`) opens with
`if (authConfig.provider !== 'dual') return;` and is called from the
**better-auth session** branch of `auth_middleware.ts:124` — i.e. it fires when a
user proves who they are on the *old* path, and mints them a Keycloak shell
just-in-time. Under `keycloak` there is no better-auth session branch, so:

> **Removing `dual` makes `scripts/migrate_users_to_keycloak.ts --apply` a hard
> prerequisite for cutover, not a best-effort step.** Any existing user without a
> Keycloak identity is locked out the moment an instance flips — Keycloak's OTP
> authenticator is login-only and answers `user_not_found`
> (`participant_identity.ts:5-9`), and `provisioning.ts:319-330` refuses to mirror
> an unknown subject on a gated instance.

`backfillKeycloakShell` and its `shellBackfillAttempted` / `attributesPersist`
memoisation become dead code and are deleted in Phase 4.

**Two mitigations make this acceptable**, and both are verified:

- **Rollback is still per-instance and safe.** `AUTH_PROVIDER` is per-instance
  env, and better-auth's code is *not* deleted by this plan. Flipping back to
  `betterauth` works even for users created only under Keycloak: `unified_otp`'s
  verify looks a user up by phone then email (`unified_otp.ts:577-589`) and login
  is passwordless, so it needs no `account` row and no password. A
  Keycloak-created mirror row is found and logged in normally.
- **The migration script already has the tools**: `--probe`, dry-run,
  `--apply`, `--reconcile` (`migrate_users_to_keycloak.ts:19-31`). `--reconcile`
  must report 1:1 before the flip.

### 2.2 What `dual` removal simplifies

| Thing | Today | After |
|---|---|---|
| `backfillKeycloakShell` + call site | `provisioning.ts:591-…`, `auth_middleware.ts:8,124` | deleted |
| `resolveKeycloakSession` fallthrough | 3-way (`resolve_session.ts:188-196`) | 2-way: handle it, or better-auth owns the request |
| `authConfig` flags | `provider` + two overlapping booleans | one boolean |
| UI provider mapping | `keycloak` → OIDC, `betterauth`/`dual` → OTP (`keycloak-config.ts`) | binary |
| Reported enum | `auth_config.ts:20`, `apps/ui/src/lib/auth-api.ts:219` | two values |

---

## 3. Current state: the five better-auth call sites (verified)

better-auth is already fully contained in `packages/auth` — no file under
`apps/api` imports a better-auth symbol; the deps are declared only in
`packages/auth/package.json`. `apps/api` touches exactly one object,
`authInstance`, built at `apps/api/src/routes/auth/create_auth.ts:16`.

| # | Site | Verb | Kind | Status under `keycloak` | Phase |
|---|---|---|---|---|---|
| 1 | `routes/v1/admin/participant.ts:128` | `api.signUpEmail` | **write** | active | **2** |
| 2 | `routes/auth/index.ts:35` (mounted `app.ts:271`) | `authInstance.handler` | **write (open door)** | active, ungated | **3** |
| 3 | `auth_middleware.ts:102`, `validate_session.ts:18` | `api.getSession` | read | already unreachable (`resolve_session.ts:192-196`) | 4 (cleanup) |
| 4 | `auth_middleware.ts:45`, `validate_api_key.ts:10` | `api.verifyApiKey` | read | deliberately dual-accept | **deferred, R8** |
| 5 | `create_auth.ts:16` | `createAuth()` at import | construct | always runs | 4 (optional) |

**Site 2 is the security-relevant one.** `app.ts:271` registers `AuthRoutes`
unconditionally and `packages/auth` has zero `AUTH_PROVIDER` awareness, so under
`keycloak` today `unified_otp`'s `verifyOtp` is still reachable and **still
creates users** (`unified_otp.ts:385`, gate at `:595`) — with no Keycloak
identity, landing them in the `user_not_found` / `already_registered` deadlock
`participant_identity.ts:11-14` describes.

**Site 4 stays.** `x-api-key` is the integrating-DPG compatibility window
(`auth_middleware.ts:25-28`); its removal is R8, gated on aggregator-dpg and
voice-dpg confirming zero traffic. It does not traverse the site-2 mount, so
Phase 3 does not break it.

**Unmounting `/api/auth/*` is safe** — verified consumers: the UI calls it only
for the OTP flow, sign-out and get-session (`apps/ui/src/lib/auth-api.ts:123-175`),
none used by the OIDC screen; API keys are minted by
`scripts/seed_service_users.ts:119-121` inserting directly with its own SHA-256,
not over HTTP; `verifyApiKey` is an in-process call, not a route.

**No `session` table exists** — not in `db/postgres/schema/auth.ts`, not in the
live DB. better-auth sessions live in Redis via `secondaryStorage`
(`packages/auth/src/config.ts:71-83`). Nothing here drops a table.

---

## 4. Feature-parity audit — the blocking work

`provisioning.ts` was written to be the app-side home of the business logic
`unified_otp` married to authentication (its docblock, `:1-31`), and it does
replicate most of it. A line-by-line audit of all three OTP endpoints against the
Keycloak path found **7 gaps**. These are the actual content of this plan.

### Already replicated (no work needed)

| Behaviour | better-auth | Keycloak path |
|---|---|---|
| Self-signup gate, at both creation points | `unified_otp.ts:334`, `:595` | `self_signup.ts:144-151` + `provisioning.ts:319-330` |
| Login-channel gate | `unified_otp.ts:314`, `:546` | `provisioning.ts:153-158`, `:181-188` |
| New-user row columns (`image:''`, `banned:false`, `banReason:''`, `termsAccepted/privacyAccepted:true`, `name` default `'user'`) | `unified_otp.ts:616-633` | `provisioning.ts:371-391`, name at `:123` |
| Guardian materialization on genuinely-new users only | `unified_otp.ts:751-753` → `create_auth.ts:47` | `provisioning.ts:445-453` |
| …and its ordering guarantee (extras applied *before* guardian, so the OTP-verified age wins) | — | `provisioning.ts:437` then `:446`, intent documented `:434-436` |
| Member dedupe scoped to `(org, user)` | `unified_otp.ts:687-693` | `provisioning.ts:492-498` |
| Identifier backfill onto an existing row | `unified_otp.ts:715-731` | `provisioning.ts:247-255` |
| Conditional update only when something changed | `unified_otp.ts:733-739` | `provisioning.ts:272-278` |

### Strictly better under Keycloak (record, don't "fix")

- **Banned users are now refused at login.** `provisioning.ts:206-213` → 403.
  `unified_otp` never checked `banned` at all.
- **Self-signup is rate-limited** — 3/identifier/h, 10/IP/h
  (`self_signup.ts:78-106`, `:172-182`). better-auth has **no** rate limiting on
  OTP endpoints (`packages/auth/src/config.ts:65-67`, `rateLimit: {enabled:false}`).
- Member-insert failures are structured `log.error` (`provisioning.ts:508-513`)
  rather than `console.log` (`unified_otp.ts:708`).

### N/A by design (Keycloak's OTP SPI owns these)

OTP generation, the `otp:phone:*` / `otp:email:*` Redis storage and 5-minute TTL,
one-time-use deletion, `deliverOtp`'s fail-loud `502 OTP_DELIVERY_FAILED`, and
the client-asserted-identifier mismatch checks (`unified_otp.ts:338-358`,
`:641-663`) — the last because there is no request body at token-validation time
and Keycloak is authoritative for identifiers (design §6.1,
`provisioning.ts:227-239`).

One caveat to carry: **signals can no longer observe an OTP delivery failure.**
Confirm the SPI is equally fail-loud, or a failed send becomes invisible.

### The 7 gaps

| ID | Gap | Severity | Evidence | Fix |
|---|---|---|---|---|
| **G2** | **Admin bootstrap is impossible.** `unified_otp.ts:604-611` sets `role: isAdmin ? 'admin' : 'user'` from `adminByDomain`, and `auth_guards.ts:43-54` lets an admin-domain email through a *gated* signup gate. Neither exists on the Keycloak path: `provisioning.ts:427` and `self_signup.ts:251` hardcode `'user'`, `refreshMirror` deliberately never syncs role (`:233-239`), and `grep "role: 'admin'"` across `apps/api/src` + `packages/auth` non-test code returns **zero hits**. On a gated instance (the default) no Keycloak code path can create the first admin. | **High** | verified directly | Decision needed — open question 1 |
| **G1** | **Welcome email + welcome WhatsApp are silently lost.** `packages/auth/src/config.ts:177-219` sends both on every new user; `createMirror` (`provisioning.ts:312-456`) sends nothing. | **High** | verified directly | Call the notifications from `createMirror` alongside `materializeSignupGuardian` (`:445`), same swallow-and-log posture |
| **G3** | **`domains` and `age` now hinge on a 30-min, fail-silent Redis stash.** `signup_extras.ts:26` `EXTRAS_TTL_SEC = 1800`; `provisioning.ts:695-721` swallows every failure. Under better-auth these were written **post-login** over an authenticated session with no TTL (`otp-page.tsx` → `setUserDomains`, `submitU18Dob`). A 30-min stall or a Redis blip leaves `domains = null` **and `age = null`** — and a null age on a gated domain is fail-closed at `item_service.ts:432`, so the user cannot publish and has no in-app way to fix it. | **High** | `oidc-callback-page.tsx` calls `setUserDomains` **0** times vs `otp-page.tsx` **2** | Have the OIDC callback perform the post-login writes, mirroring `otp-page.tsx`; keep the stash as the fast path |
| **G4** | **The returning gated minor's pre-OTP DOB capture is gone.** `login-page.tsx` runs `u18Precheck` and collects birth year before OTP; `otp-page.tsx` then persists it (`submitU18Dob`) and runs the authenticated guardian flow. The OIDC callback does none of it, orphaning `POST /api/v1/auth/u18-precheck`. Backstops still hold (`item_service.ts:417-440` is fail-closed), so this is a completion/UX regression, not a safety hole — but a migrated minor is blocked from going live with no explanation. | **Medium** | `submitU18Dob`/`getU18Status` in callback: **0**; otp-page: **3**/**2** | Port the post-login U18 completion into `oidc-callback-page.tsx` |
| **G7** | **The wrong-portal domain gate is missing from the OIDC callback.** `otp-page.tsx` runs `resolveHeldDomains` + `evaluateDomainGate` and force-`signOut()`s a user holding a profile in a domain this deployment doesn't serve. | **Medium** | callback: **0**, otp-page: **2** each | Port into `oidc-callback-page.tsx` |
| **G6** | **`emailVerified` / `phoneNumberVerified` may never become true.** `unified_otp.ts:719-730` flips them for the channel just proven. `provisioning.ts:250-258` only trusts the `email_verified` / `phone_number_verified` claims, and signals creates realm users **unverified** (`self_signup.ts:246-253`, `participant_identity.ts:126-137`). If the OTP SPI doesn't flip the realm attributes on success, every signals-created user stays unverified forever. | **Medium–High, unconfirmed** | SPI JAR is not in this repo | **Verify the SPI first** (open question 3). If it doesn't flip them, set them in `provisioning.ts` from the channel the token proves |
| **G5** | **Org join is contract-changed and currently dead.** `unified_otp.ts:676-679` joined by org **slug** from the request body; `ensureOrgMembership` keys on an org **id** from the `signalstack_org_id` claim (`provisioning.ts:80`, `:476-480`) that **nothing in signals writes** — `mapUserToKeycloak` emits only `phoneNumber`, `phoneNumberVerified`, `banReason`, `banExpires` (`user_to_keycloak.ts:126-141`). So `identity.orgId` is always `null` for signals-created users and `ensureOrgMembership` returns at `:473` every time. Also `404` → `log.warn`+skip, and role default `'viewer'` → `'member'`. | **Low** (no `apps/ui` caller sends `joinOrg`) | verified | Confirm intentional; either populate the attribute or document the capability as withdrawn |

Note G5 overlaps a bug found earlier in this workstream: the `signals-ui` client's
mapper emits the claim as **`signals_acting_orgs`**, not `signalstack_org_id`, so
`ORG_ID_CLAIM` (`provisioning.ts:80`) would not match even if the attribute were
populated. Fix both together.

---

## 5. Design

### 5.1 One user-insert, two callers

New **`apps/api/src/services/auth/user_writer.ts`**, extracted from `createMirror`,
owning the `user` insert and nothing else.

```ts
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LocalUserInsert {
  /** Plain UUID — becomes the Keycloak `sub`. Never prefixed (§5.3). */
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  /** Caller-owned columns: onboarding attribution, age, domains, consent flags. */
  extra?: Partial<typeof userTable.$inferInsert>;
}

export type LocalUserWriteResult =
  | { ok: true; created: boolean; id: string }
  | { ok: false; code: 'IDENTITY_CONFLICT' | 'USER_WRITE_FAILED'; message: string };

export async function insertLocalUser(
  input: LocalUserInsert, log: FastifyBaseLogger, exec?: Executor,
): Promise<LocalUserWriteResult>;
```

**Defaults**, read off the two rows `signUpEmail` + the onboarding update actually
produced in the live DB, so both callers keep their current shape:
`role='user'`, `image=''` (empty string, not null), `banned=false`,
`banReason=''`, `banExpires=null`, one shared `createdAt`/`updatedAt`, `tags`
omitted (DB default `{}`).

**`termsAccepted` / `privacyAccepted` are deliberately not defaulted.** The two
callers disagree and both are right: first-login provisioning sets them `true`
(`createMirror:384-388`), admin onboarding leaves them `false` because consent
lives in the ledger since #309 (`participant.ts:75-77`). Supplied via `extra`.

It does **not** write an `account` row, a password, or a synthesised email, and it
makes no Keycloak call. It returns `created:false` on a 23505 re-read and
`IDENTITY_CONFLICT` when the row is still absent — the same discrimination
`createMirror:392-415` makes today.

### 5.2 What better-auth's `signUpEmail` costs on the write path

Three artifacts, all confirmed present in the live database. **Re-measured after a
day's local onboarding: this affects essentially every admin-onboarded user, not a
handful — 24 of 25 rows.**

| Artifact | Cause | Live evidence |
|---|---|---|
| Fake email on phone-only participants | `email_for_signup = email_norm ?? \`${randomUUID()}@no-email.local\`` (`participant.ts:418`, `:739`) — `signUpEmail` demands an email | **24 of 25** `user` rows match `%@no-email.local` |
| Dead credential row | `signUpEmail` writes `account` with `provider_id='credential'` + a hash of a discarded `randomUUID()` (`participant.ts:131`) | **24 rows**, all with a password |
| The fake email becomes the Keycloak **username and email** | `participant.ts:234` passes it into `createParticipantKeycloakIdentity` | 24 realm users in `bluedots` are keyed on `<uuid>@no-email.local` |

The third row is worse than a cosmetic issue: the realm identity's username *is*
the throwaway address, so the only email these users could ever be reached at is
one that bounces. Their phone is the sole usable channel — which does work
(verified: the `phoneNumber` attribute persists, see §6 Phase 0).

`user.email` is nullable (`schema/auth.ts:13`, `is_nullable=YES`), and NULL is the
already-handled state — `resolve_owner.ts:8-9` documents "returns null when the
user … has no email (phone-only)", `signup_guardian.ts:252` guards on
`if (user.email)`, and every other read is a conditional `eq(user.email, …)`.
NULL is *more* correct than an address no lookup could ever match.

### 5.3 The id invariant

better-auth generated ids via `advanced.database.generateId: () => crypto.randomUUID()`
(`packages/auth/src/config.ts:31`). The direct path calls `randomUUID()` itself and
**must produce a bare UUID**: the id becomes the Keycloak `sub`
(`keycloak user.id == sub == signals user.id`, design §2.3/§6.1) and is handed to
`createUserPreservingId` via `partialImport`. A prefixed id like the `usr_` form
`seed_service_users.ts` uses for service accounts breaks the invariant. The writer
should reject a non-UUID id rather than trust callers.

### 5.4 The switch

Branch on `authConfig.keycloak_enabled` (`apps/api/src/config.ts:66`). No new env
var. Once `dual` is gone this is an exact binary, and it mirrors how
`participant_identity.ts:109` and `resolve_session.ts:188` already branch.

---

## 6. Phased plan

The ordering constraint that matters: **Phase 3 is the moment better-auth actually
stops running, so all of Phase 1 must land first.** Phase 2 is independent and can
run in parallel. Phase 4 is cleanup and needs a real instance to have run on
`keycloak` successfully.

### Phase 0 — prerequisites, no code

1. **Verify the OTP SPI's verification behaviour (G6).** Does successful OTP
   verification set `emailVerified` / the `phoneNumberVerified` attribute on the
   realm user? The JAR is not in this repo. This single answer decides whether
   Phase 1 needs a mirror-side fix.
2. **Confirm the SPI is fail-loud on delivery failure**, since signals can no
   longer see a failed send.
3. **Decide admin bootstrap (G2)** — open question 1. Blocks Phase 3.
4. **Run `migrate_users_to_keycloak.ts --probe`, then `--apply`, then
   `--reconcile` until 1:1.** With `dual` gone this is mandatory, not
   best-effort (§2.1).

**Gate:** G6 answered; `--reconcile` reports zero local users without a Keycloak
identity; admin-bootstrap approach agreed.

#### Phase 0 findings (2026-07-31)

- **✅ The `phoneNumber` attribute persists.** Checked a full realm-user record in
  `bluedots`: `attributes.phoneNumber` and `phoneNumberVerified` are both present,
  and `GET /users/profile` declares them with
  `unmanagedAttributePolicy: ENABLED`. So `apply-user-profile.sh` has been applied
  and phone OTP login is possible for admin-onboarded participants.
  *Caution for anyone re-checking this:* `kcadm get users --fields attributes` returns
  `attributes: {}` even when attributes exist — the list projection does not
  populate them. Fetch `users/<id>` without `--fields`, or you will conclude the
  attribute was silently discarded.
- **✅ The realm is now `bluedots`** (was `aggregator`), i.e. the aggregator plan's
  Phase A rename has landed. Any earlier finding measured against the `aggregator`
  realm — including the G5 claim-name mismatch — should be re-verified here.
- **⬜ G6 is still open.** All 25 realm users are unverified with no credentials,
  because none has logged in yet, so existing state cannot answer whether the SPI
  flips the flags. Answering it needs either the authenticator JAR (it lives in
  aggregator-dpg, not here) or one live OTP login against the local stack —
  feasible since `CREATE_TEST_OTP` fixes the code to `000000`.
- **⬜ G2 (admin bootstrap) is still open** — open question 1. This is the one that
  blocks Phase 3.

### Phase 1 progress

- **✅ G1 — done.** `apps/api/src/notifications/welcome.ts` now owns the welcome
  email + WhatsApp, called from both `create_auth.ts`'s `afterUserCreate`
  (better-auth) and `createMirror` (`provisioning.ts`, Keycloak). The bodies were
  removed from `packages/auth/src/config.ts` so the two providers cannot diverge.
  12 new tests; `pnpm typecheck` clean; `packages/auth` 25/25 green.
- **✅ G3 / G4 / G7 — done**, as one change to `oidc-callback-page.tsx` plus a new
  `apps/ui/src/lib/pending-signup-extras.ts` (read-once localStorage carrier,
  mirroring `pending-consent.ts`) parked by `keycloak-login-panel.tsx` at the
  point of redirect. The callback now runs, in `otp-page.tsx`'s order:
  domain gate → parked-consent flush → durable domain/age write → U18 guardian
  gate → adult consent gate → land. 16 new tests.
  - The Redis stash is kept as the fast path; the authenticated write is the
    backstop, and the two are idempotent.
  - **Ordering that matters and is now test-locked:** the parked age is submitted
    *before* `getU18Status`, or a fresh minor's age is not yet stored and the gate
    reports `isMinor: false`, silently skipping the guardian capture. The U18 gate
    runs *before* the adult consent gate, so a gated minor is not shown adult
    terms (#453).
  - G4's pre-login DOB capture has no Keycloak equivalent (the chooser collects no
    identifier, so `u18Precheck` cannot run). Resolved by capturing it post-login
    instead, via `initialStep: 'dob'` when no birth data is stored.
- **✅ G2 — done** (the bootstrap half). `apps/api/scripts/create_admin_user.ts`
  (`pnpm keycloak:create:admin`) creates or **promotes in place** a signals admin
  and its Keycloak identity under the same id, carrying the `signals_admin` realm
  role. Dry-run by default. `adminByDomain` was deliberately **not** ported —
  admin creation is now an explicit operator action rather than an
  email-domain-implies-admin rule.
  - Verified end to end against the local stack: create, idempotent re-run,
    promote-in-place (id preserved — it is referenced by `items.created_by`), and
    the `sub == user.id` invariant. Test data removed from both systems
    afterwards.
  - **A preflight Keycloak auth check was added after a real failure.** The first
    run pointed at the wrong port, committed the local `role='admin'` row, then
    failed on Keycloak — leaving a privileged user who could never sign in. The
    script now proves Keycloak is reachable *before* any write, and on a later
    Keycloak failure rolls the local write back: **deleting** a row it created,
    but only **reverting the role** on a pre-existing user, since that row's id is
    load-bearing.
  - **Finding that makes the follow-up cheap:** `partialImport` **does** honour
    `realmRoles` — confirmed by reading Keycloak's own
    `/role-mappings/realm` back, via a new `KeycloakAdminClient.realmRolesFor()`,
    rather than trusting the representation sent. Combined with the already-present
    but unused `hasRealmRole()` (`utils/keycloak_token.ts:309`) and
    `realmRoleFor()` (`user_to_keycloak.ts:102`), the realm-role → `user.role`
    sync is now mostly a matter of wiring, not new infrastructure.
  - **Safe way to land that follow-up:** read the realm role in `createMirror`
    only (new mirrors), not `refreshMirror`. There is no existing admin to demote
    on a first login, so the demotion risk that keeps `refreshMirror` from syncing
    role (`provisioning.ts:233-239`) does not apply there.
- ⬜ G6 — deferred by decision; still the Phase 0 blocker for cutover.
- **✅ G5 — done, and it was not a parity gap.** Re-verified against the renamed
  `bluedots` realm: the `signals-ui` client emits the claim as
  **`signals_acting_orgs`** (sourced from the `signalstack_org_id` *user
  attribute*), while `provisioning.ts` read a claim literally named
  `signalstack_org_id`. So `orgId` was always null and `ensureOrgMembership` never
  ran — and the tests asserting the old claim name passed the whole time.
  - Not a regression from better-auth: `unified_otp`'s `joinOrg` needed a
    request-body org **slug** that no `apps/ui` caller ever sent, so the capability
    was dead on both providers. This was a latent bug in new code that *looked*
    live, which is worse than an absent feature.
  - Now reads the grant through the existing `actingOrgGrant`, adopting it only
    when it names exactly **one concrete** org. A wildcard (`['*']`) or multi-org
    grant states what a caller may *act for*, not what they are a member of.
    Correct for the human path specifically, since `resolve_session.ts` forks
    service tokens away first and a human's grant is their own single org
    attribute (design §5.1).
  - Answers open question 4: **restored, not withdrawn** — no new realm config
    needed, because the mapper already carries the value.

### Phase 2/3/4 progress

- **✅ Phase 3 — done.** `app.ts` registers `/api/auth/*` only when
  `betterauth_enabled`. Under `keycloak` the whole better-auth surface is a 404,
  including `unified-otp/verify`, which could otherwise still create users.
  Mutation-tested: reverting the gate fails exactly the two absence assertions.
- **✅ Phase 4 — done.** `AUTH_PROVIDER` is `betterauth | keycloak`;
  `backfillKeycloakShell` and its ~275-line test file are deleted;
  `resolveKeycloakSession` returns `fallthrough` only under `betterauth`;
  `assertAuthProviderSupported` fails a `dual` instance at startup with an
  actionable message rather than a bare Zod enum error. `.claude/rules/auth-model.md`
  and `packages/auth/CLAUDE.md` updated — they documented `dual` as live.
- **◐ Phase 2 — part 1 done.** `services/auth/user_writer.ts` now owns the `user`
  insert, shared by `createMirror`, with an executor seam for transactions and an
  id guard. **Part 2 (switching `participant.ts`) is held back** because it edits
  `signUpAndOnboardUser`, which had uncommitted work in progress.

### The local test suite was misleadingly red

Every one of the "16 pre-existing API failures" traced to a single invalid value:
the schema accepts `MATCH_SCORE_PROVIDER` as `'signals_search'` **or absent**, and
a root `.env` carrying anything else fails the whole env parse at
`src/config.ts` import — taking out every test whose module graph reaches config.
With it corrected the suite is **88 files / 860 tests, zero failures**. Fix the
`.env` line rather than working around it; `vitest.setup.ts` loads that file with
`override: false`, so a bad value wins.

### Still open after this pass

1. **G6** — does the OTP SPI flip `emailVerified` / `phoneNumberVerified`? Blocks
   cutover, not Phase 1. Needs the authenticator JAR or one live OTP login.
2. **Phase 0.4** — run `migrate_users_to_keycloak.ts --apply` / `--reconcile` to
   1:1. Mandatory once `dual` is gone (§2.1).
3. **The realm-role → `user.role` follow-up** (G2's second half), safe to land in
   `createMirror` only.
4. **The pre-existing admin-onboarding U18 bug** (§1) — its own issue.
5. **Phase 2, part 2** — point `signUpAndOnboardUser` at `insertLocalUser`,
   collapsing its insert+update into one transactional insert, and pass
   `email_norm` rather than `email_for_signup` into
   `createParticipantKeycloakIdentity` so the realm identity stops carrying the
   `@no-email.local` address. Blocked only on the in-flight work in that file.

**Verification protocol for this work.** `pnpm --filter api test` and
`pnpm --filter ui test` both have **pre-existing failures** unrelated to this
plan — 2 API tests (openapi, from `config.ts` env parsing when the root `.env` is
not loaded) and 4 UI tests (`profile-form-page.landmarks`,
`guardian-otp-dialog`, which pass in isolation and fail only in the full run).
Baseline them by stashing before concluding anything from a red suite:
API 761/763 and UI 500/504 at the time of writing.

### Phase 1 — close the parity gaps (blocking)

| Gap | Change |
|---|---|
| G1 | Welcome email + WhatsApp from `createMirror`, beside `materializeSignupGuardian` (`provisioning.ts:445`). Extract the bodies out of `packages/auth/src/config.ts:177-219` into a provider-neutral module so both providers send the same thing |
| G3 | `oidc-callback-page.tsx` performs the post-login `domains` / `age` writes, mirroring `otp-page.tsx`. Keep the Redis stash as the fast path, so the callback is the durable backstop rather than the only mechanism |
| G4 | Port the post-login U18 completion (`submitU18Dob` / `getU18Status` / authenticated guardian flow) into the OIDC callback |
| G7 | Port `resolveHeldDomains` + `evaluateDomainGate` (force-sign-out on wrong portal) into the OIDC callback |
| G6 | Only if Phase 0 says the SPI does not flip the flags: set `emailVerified` / `phoneNumberVerified` in `provisioning.ts` from the channel the token proves |
| G2 | Per the open-question-1 decision |
| G5 | Per the open-question-4 decision; fix the `ORG_ID_CLAIM` name mismatch either way |

G3, G4 and G7 are all the same shape — *things `otp-page.tsx` does after login that
`oidc-callback-page.tsx` does not*. Do them as one change to that page, not four.

**Gate:** on a `keycloak` instance — a brand-new adult signup receives the welcome
email/WhatsApp and lands with `domains` set; a brand-new minor in a gated domain
gets `minor_guardian` + 3 U18 `consent_record` rows and can publish; a returning
minor with no `age` is prompted before being blocked; a user holding an unserved
domain is signed out; `email_verified` is true after an OTP login.

### Phase 2 — direct user write (site 1)

1. Add `services/auth/user_writer.ts` (§5.1).
2. Refactor `createMirror` to call it — behaviour-preserving; `provisioning.test.ts`
   is the regression net.
3. Branch `signUpAndOnboardUser` (`participant.ts:113-262`) on
   `keycloak_enabled`. The insert and the onboarding update **collapse into one
   insert** that joins the existing transaction:

```
today (betterauth):                    keycloak:
  signUpEmail            (no tx)         db.transaction(tx =>
  updateExecutor         (may be tx)       insertLocalUser(tx, {...fields, ...buildOnboardingSet(f)})
    ├─ tx.update                           create_profile_item(tx, …)   // create_new_user branch only
    └─ create_profile_item              )
  + orphan delete on update failure      // none needed — tx rolls back
  createParticipantKeycloakIdentity      createParticipantKeycloakIdentity  (remote, outside tx)
  + orphan delete on identity failure    + orphan delete on identity failure  (unchanged)
```

4. Pass `email_norm`, not `email_for_signup`, into
   `createParticipantKeycloakIdentity` (replacing `participant.ts:234`) so the
   realm identity stops carrying the fake address.

The update-failure orphan cleanup (`participant.ts:166-181`) disappears on this
branch — there is no committed row to orphan. The Keycloak-identity compensating
delete (`:239-259`) **stays**: it is a remote call and cannot be in the transaction.

Error mapping preserved: `IDENTITY_CONFLICT` → 409 `USER_ALREADY_EXISTS`,
`USER_WRITE_FAILED` → 500 `ONBOARD_FAILED`, `create_profile_item`'s typed
`{statusCode, errorCode}` still passes through (`:191-199`).

**Gate:** under `keycloak`, onboarding a phone-only participant yields `email IS
NULL`, **zero** new `account` rows, a Keycloak identity whose id equals `user.id`
and whose email is unset, and that participant completes an OTP login. Under
`betterauth` the row is byte-identical to today's.

### Phase 3 — close the better-auth HTTP surface (site 2)

```ts
if (authConfig.betterauth_enabled) app.register(AuthRoutes);   // app.ts:271
```

Under `keycloak` this removes `/api/auth/*` entirely, including
`unified-otp/check-user|request|verify`, `sign-out` and `get-session`.

Prefer unmounting to a 410 inside the handler: an unmounted route cannot be
reached by a path we failed to think of, whereas an in-handler guard must be right
for every one of better-auth's endpoints.

**Gate:** under `keycloak`, `POST /api/auth/unified-otp/verify` → 404 and creates
nothing; OIDC login unaffected; `x-api-key` auth still works. Under `betterauth`,
every OTP endpoint responds as before.

### Phase 4 — remove `dual` and clean up (sites 3, 5)

1. `AUTH_PROVIDER` → `z.enum(['betterauth','keycloak'])`
   (`secrets.ts:51`), and the startup guard at `:121-145`.
2. Delete `backfillKeycloakShell` + its `shellBackfillAttempted` /
   `attributesPersist` state and the `auth_middleware.ts:8,124` call.
3. Simplify `resolveKeycloakSession`'s three-way return to two-way
   (`resolve_session.ts:188-196`), and collapse `authConfig`'s flags to one boolean.
4. Update the reported enum (`auth_config.ts:20`,
   `apps/ui/src/lib/auth-api.ts:219`) and the UI mapping (`keycloak-config.ts`).
5. Remove the now-dead `getSession` calls (site 3) from `auth_middleware.ts:102`
   and `validate_session.ts:18`.
6. **Optional (site 5):** make `authInstance` lazily constructed so better-auth
   is not instantiated at import under `keycloak`. Hold this unless `verifyApiKey`
   has also gone — otherwise the instance is built on the first `x-api-key`
   request anyway and the saving is boot-time only.
7. Update `.claude/rules/auth-model.md` and `packages/auth/CLAUDE.md`, both of
   which document `dual` and the two-gate invariant.

**Gate:** `AUTH_PROVIDER=dual` is rejected at startup with a clear message; both
remaining modes pass the full suite; docs match.

### Deferred — `x-api-key` → bearer (site 4, R8)

Out of scope. Blocked on aggregator-dpg Phase C/E and voice-dpg confirming zero
`x-api-key` traffic. See `2026-07-29-aggregator-keycloak-integration-plan.md` §4.

---

## 7. Tests

Two things carry the most risk: the parity gaps silently reopening, and row-shape
drift between the two providers.

| Test | Where | Asserts |
|---|---|---|
| Welcome notifications on new-user provision (G1) | `services/auth/__tests__/provisioning.test.ts` | notify called for email and phone; a notify failure does **not** fail the login |
| Post-login completion runs on the OIDC callback (G3/G4/G7) | `pages/auth/__tests__/oidc-callback.test.tsx` | `setUserDomains`, U18 DOB/guardian, and the domain gate all fire; wrong-portal user is signed out |
| `domains`/`age` survive an expired stash (G3) | integration | stash absent → the callback still persists them |
| Verification flags true after login (G6) | `provisioning.test.ts` | per the Phase 0 answer |
| Admin bootstrap (G2) | per decision | a gated instance can still create its first admin |
| Writer defaults + no consent-flag defaulting | `services/auth/__tests__/user_writer.test.ts` (new) | the §5.1 default table; `termsAccepted`/`privacyAccepted` absent unless passed |
| 23505 → `created:false`; still-missing → `IDENTITY_CONFLICT` | same | mirrors `createMirror:392-415` |
| Writer joins a caller's transaction | same | insert uses the passed executor |
| **Branch equivalence** | `routes/v1/admin/__tests__/participant.test.ts` | same body under both providers → diff the row column-by-column; only `email` may differ (fake vs NULL) |
| No new `account` row under `keycloak` | `participant.integration.test.ts` | count unchanged across an onboard |
| Transaction rollback leaves no row | same | force `create_profile_item` to fail → zero rows, no orphan-delete issued |
| Keycloak-identity failure still deletes the row | same | contract of `participant.ts:239-259` unchanged |
| Mount gated (Phase 3) | `routes/auth/__tests__/` (new) | `unified-otp/verify` → 404 under `keycloak`; responds under `betterauth` |
| `dual` rejected (Phase 4) | `packages/config/src/__tests__/keycloak_secrets.test.ts` | startup error names the removed value |
| `provisionUserFromClaims` unchanged | `provisioning.test.ts` | existing suite passes untouched |

**`participant.test.ts` currently mocks `authInstance.api.signUpEmail` (`:54-56`).**
Keep it for the `betterauth` branch and assert it is **never called** on the
`keycloak` branch — otherwise a regression that quietly keeps using better-auth
still passes.

Run: `pnpm --filter api test`, then
`docker compose up -d db redis && pnpm --filter api test:integration`, plus
`pnpm --filter ui test` for the callback-page work.

---

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Cutover locks out un-migrated users** — no `dual`, so no JIT shell backfill | **High** | Phase 0.4: `--reconcile` must be 1:1 before any flip. Rollback to `betterauth` is per-instance and verified safe (§2.1) |
| 2 | **A parity gap is missed and ships** | **High** | §4 is the checklist; Phase 3 is gated on Phase 1's gate passing. The audit was line-by-line over all three OTP endpoints |
| 3 | **G2 blocks a fresh deployment** — a new gated instance cannot create its first admin | **High** | Phase 0.3 decision, before Phase 3 |
| 4 | **Row-shape drift** between providers, surfacing months later in a join or report | Medium | Branch-equivalence test; defaults read off real rows, not inferred |
| 5 | **Two inserts drift** (`createMirror` vs onboarding) | Medium | The single shared writer is the whole reason for extraction over a second module |
| 6 | **G6 turns out worse than expected** — the SPI never verifies, so every user is permanently unverified | Medium | Phase 0.1 answers it before any code is written |
| 7 | Phase 3 unmounts something the audit missed | Medium | §3 consumer audit; grep a `keycloak` instance's access logs for `/api/auth/` — expect zero. Reversible in one line |
| 8 | Existing artifacts (2 fake-email rows, 2 dead credential rows) are not cleaned | Low | Deliberate — open question 5. New writes stop immediately |
| 9 | A caller passes a prefixed id, breaking `sub == user.id` | Medium | §5.3 — the writer rejects non-UUID ids |

---

## 9. Open questions

1. **How is admin bootstrap done under Keycloak (G2)?** Blocking. Three options:
   - **(a) Replicate `adminByDomain`** in `provisioning.ts` / `self_signup.ts` —
     smallest diff, preserves today's behaviour exactly, but keeps an
     email-domain-implies-admin rule that is weak authorisation.
   - **(b) Map a Keycloak realm role → `user.role`** — the "right" answer for a
     Keycloak world and auditable in one place, but `refreshMirror:233-239`
     deliberately does *not* sync role today precisely because assigning realm
     roles before they exist would demote every existing admin. Needs the realm
     roles created and assigned first.
   - **(c) Admin bootstrap by script only** (extend `seed_service_users.ts`) —
     no login-path change at all; admins become an ops action.
   *Recommendation: (b) as the destination, (c) as the immediate unblock, and
   explicitly not (a).*
2. **The pre-existing admin-onboarding U18 bug** (§1): an admin-onboarded minor
   never gets `minor_guardian` or U18 consent rows, on either provider, because
   `signUpEmail` never fired `afterUserCreate`. Out of scope here — file it
   separately, or fold it into Phase 2 while that code is open?
3. **Does the OTP SPI set the verification flags (G6)?** Needs someone to check
   the authenticator JAR / a live OTP login against the realm user.
4. **Org join (G5): restore or withdraw?** Nothing signals writes populates the
   claim and no UI caller sends `joinOrg`, so it is dead either way today. Restore
   slug-based join, populate the attribute, or document the capability as
   withdrawn?
5. **Backfill the existing artifacts?** Null `email` where it matches
   `%@no-email.local` and delete the orphaned `credential` `account` rows. Both
   safe (neither can authenticate) but both are data changes wanting their own
   migration — and the fake email also exists on those users' **Keycloak**
   identities, so a full cleanup is two-sided.
6. **Hard-remove `dual`, or ship it as a deprecated value that fails at startup
   for one release?** The latter gives operators a clear error instead of a Zod
   parse failure on an unknown enum value.
