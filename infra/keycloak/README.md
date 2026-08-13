# infra/keycloak

Signals' Keycloak configuration for the better-auth → Keycloak migration
(`docs/superpowers/plans/2026-07-23-keycloak-migration-design.md`), including
the custom email/phone **OTP authenticator SPI** that provides the actual login
experience.

## Who owns what

An instance runs **one Keycloak deployment holding one realm, `bluedots`**,
shared by that instance's signals API and aggregator (§3.1). Separation between
the two DPGs is by **client and realm role**, not by realm.

**This directory is the source of truth for that realm and for the OTP SPI.**
Both were originally maintained in `aggregator-dpg/infra/keycloak/`; ownership
moved here so the shared identity artifacts have one home (this settles open
question 6 of the design doc, which left it unanswered).

| Path | Purpose |
|---|---|
| `realms/bluedots-realm.json` | The importable `bluedots` realm: signals' clients and roles, the OTP browser flow, themes, and SMTP. |
| `providers/keycloak-otp-1.0.0-SNAPSHOT.jar` | The custom email/phone OTP authenticator SPI. Committed deliberately (see `providers/.gitignore`) so Keycloak boots with a working login out of the box. |
| `themes/otp/` | Login + email theme the flow renders (FreeMarker templates, CSS/JS, brand assets). |
| `render-realm.sh` | Substitutes `__PLACEHOLDER__` tokens into the realm JSON at container start. |
| `init/apply-user-profile.sh` | Post-boot Admin-REST fixup. **Not optional** — see below. |

> **aggregator-dpg still has its own copy** of these files. Until it is pointed
> at this one, changes must be mirrored. The realm-level settings both DPGs
> share — the OTP flow, themes, SMTP, the user profile — must not diverge.

## The OTP flow

The SPI registers these authenticators (visible in the Keycloak boot log):

- `otp-identifier-form` — collects an email / phone / username
- `otp-channel-choice-form` — routes to a channel and verifies the code
- `sms-otp-form`, `email-otp-form` — the per-channel forms
- `urn:otp:sms`, `urn:otp:email` — direct grant types

The realm binds `bluedots-otp-browser` as its `browserFlow`, which chains
`auth-cookie` (existing session) alternately with `bluedots-otp-forms`
(identifier → OTP). Code length, TTL and retry limits live in the
`bluedots-otp-choice-config` authenticator config, and the phone number is read
from the **`phoneNumber` user attribute** (`otpChoice.phoneAttribute`).

> **Flow aliases are `bluedots-*`, not `aggregator-*`.** The realm is shared and
> now signals-owned, so the aliases are named after the realm rather than one of
> its two consumers. Aggregator's export uses `aggregator-otp-browser`; whichever
> import runs first wins, so the two must be reconciled to one alias before both
> repos import into the same realm.

## Delivery channels

| Channel | Local dev | Production |
|---|---|---|
| **Phone** | `KC_SPI_SMS_PROVIDER=log` writes the code to the Keycloak container log — `docker compose logs -f keycloak \| grep -i otp`. No SMS account needed. | `twilio`, `sns` or `msg91` with the matching credentials. |
| **Email** | Mailpit in the `keycloak` compose profile catches everything; read it at <http://localhost:8025>. | Real SMTP via the `SMTP_*` vars. |

Keycloak logs a warning on boot about `kc.spi-sms-provider` using "the legacy
format": the option still applies at runtime, and this matches how aggregator
configures it today, so it is left as-is rather than diverged. Worth revisiting
together with aggregator rather than in one repo.

## Three things that will bite you

**1. The realm JSON is only read on FIRST import.** Once the realm exists in
Keycloak's database, edits here are ignored. Re-import into a fresh volume
(`docker compose down -v`) or apply the change via the Admin API.

**2. `init/apply-user-profile.sh` is mandatory, not a nicety.** Keycloak 26
**ignores `kc.user.profile.config` from a realm import** — verified on 26.5.5.
Without the fixup, `phoneNumber` is an undeclared attribute and Keycloak
*silently discards* writes to it. The failure is invisible: users are created
successfully, an id-only reconcile passes, and yet the OTP authenticator has no
number to send a code to, so phone login just doesn't work with nothing in any
log. The local-setup compose runs it as the `keycloak-init` one-shot; any other
deployment must run it too.

**3. Keycloak's default profile requires `email`, `firstName` AND `lastName`.**
That does not match signals' data model — `user.email` is nullable, phone-only
identities are first-class, and a one-word name legitimately has no last name.
Left as-is, the `VERIFY_PROFILE` required action fires on first login and parks
the user on **"Update Account Information"**, and *filling in the email does not
clear it* because `lastName` is still missing. `apply-user-profile.sh` drops the
`required` flag from all three and fails loudly if any survives. `VERIFY_PROFILE`
itself stays enabled — with nothing required it simply has nothing to demand.

> Since the realm is shared, this relaxes the requirement for aggregator's users
> too. That only stops Keycloak *forcing* the fields; aggregator's own flows
> collect them anyway. Worth confirming with that side before promoting.

## Realm roles

Realm roles are a **shared namespace** across both DPGs (risk R9), so signals'
roles are prefixed to keep clear of aggregator's `org_owner`:

- `signals_participant` — a human participant of the Signals Stack.
- `signals_admin` — elevated signals operator; successor to the local
  `user.role` column better-auth's admin plugin populated.

**One of these is required on the human session path** — `resolve_session.ts`
checks the token against `KEYCLOAK_REQUIRED_REALM_ROLES` (default
`signals_participant,signals_admin`) after the client allowlist, and answers
`403 TOKEN_ROLE_REJECTED` if neither is present. It is the second gate around the
shared realm: the allowlist rests on `azp`/`aud`, which an aggregator client
given an `aud` mapper naming `signals-ui` would satisfy, whereas a realm role is
assigned by the realm and not chosen by the client. Both signals provisioning
paths stamp one (`user_to_keycloak.ts`), so every migrated or self-signed-up user
has it — a token that reaches this and fails means either the client is missing
the `roles` scope (no `realm_access` in the token at all) or the migration did not
assign the role; `scripts/create_admin_user.ts` verifies assignment for exactly
that reason. Setting the var empty disables the check, leaving the client
allowlist as the only cross-DPG gate.

## Clients

| Client | Type | Purpose |
|---|---|---|
| `signals-ui` | public, Auth-Code + PKCE | The React UI's login flow. |
| `signals-api` | confidential, service account | Resource server. Its service account holds `realm-management` roles for the provisioning sync and admin participant creation. |
| `aggregator-dpg` | confidential, client-credentials | Replaces aggregator's `x-api-key` on the service path (R6). |
| `voice-dpg` | confidential, client-credentials | Same, for voice-dpg. |

`signals-api` validates that a token's `azp`/`aud` names one of these
(`KEYCLOAK_ACCEPTED_CLIENT_IDS` / `KEYCLOAK_SERVICE_CLIENT_IDS`) — in a shared
realm an aggregator-issued token is signature- and issuer-valid against signals,
so this check is what keeps the two populations apart. See
`apps/api/src/utils/keycloak_token.ts`.

`signals-api` itself is **not** in the default human allowlist: it is the API's
own Admin-REST client, and `resolveServiceAccount` rejects it on the service path
too (it is not an integrating DPG). Listing it would have made the one client
that can mint itself a token also a valid human session. The human path
additionally requires a *named* client — a token with no `azp` is rejected, not
waved through, since the audience gate accepts on an `aud` match alone.

> **On `manage-realm`.** `signals-api`'s service account is granted it in
> addition to the user-scoped roles, because the R4 user migration uses
> `partialImport`, which requires it. (`POST /users` 403s without it and — as
> verified on 26.5.5 — does not preserve a supplied user id at all, which is why
> `partialImport` is the migration path. See
> `apps/api/scripts/migrate_users_to_keycloak.ts --probe`.) Day-to-day operation
> needs only `manage-users`, so consider dropping `manage-realm` post-migration
> or moving it to a migration-only client.

## Branding

`themes/otp/login/theme.properties` reads brand strings, fonts and colours from
env vars via `${env.VAR:default}`. **Its shipped defaults say "Aggregator"**, so
the local-setup compose sets signals' own `BRAND_*` / `HERO_*` values. The theme
is mounted from disk, which overrides the copy baked into the provider jar — so
branding changes need no jar rebake.

## Secrets

The `secret` values in the realm JSON are **dev placeholders**, matching
aggregator's convention (`…-dev-secret-change-me`). Real deployments override
them per environment; never promote this file's secrets.
