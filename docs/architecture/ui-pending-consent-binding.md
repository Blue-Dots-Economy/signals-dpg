# Pending consent across the Keycloak redirect

Code: `apps/ui/src/lib/pending-consent.ts`, `apps/ui/src/lib/bff-session.ts` (`startBffLogin`),
`apps/ui/src/pages/auth/keycloak-login-panel.tsx`, `apps/ui/src/pages/auth/oidc-callback-page.tsx`,
`apps/api/src/services/auth/oidc_flow_state.ts`.

## Problem

`POST /api/v1/consent/accept` is authenticated, so consent accepted on the login screen can only be
written once a session exists. Signing in leaves the SPA for Keycloak's hosted pages, so in-memory
and router state are gone by the time the browser returns to `/auth/callback`. The acceptance is
therefore parked in `localStorage`.

`localStorage` is shared by every tab and survives indefinitely. If a sign-in is abandoned on
Keycloak's pages, the parked entry stays behind. Without a binding, the next Keycloak callback on
that device (possibly a different person) would post it against its own session. The body
(`ConsentAcceptBody`: `{ network, brand, source, items }`) carries no subject, so the server
attributes the acceptance to whoever is signed in and cannot detect the substitution. That would be
manufactured evidence of consent. QR/kiosk registration on shared phones is a core journey, so this
ordering is realistic.

## Design

- The entry is bound to the login attempt that created it. The caller mints an opaque `attempt` id
  (`newConsentAttemptId`), parks it with the body, and passes it to `startBffLogin`, which sends it
  to the API as `consentAttempt`. The API keeps it in the flow state for that login's OIDC `state`
  and hands it back on the callback redirect.
- `takePendingConsent(expectedAttempt)` returns the body only when the stored id and the returned id
  are both present and equal. A different person's login carries a different `state`, so it cannot
  consume the entry, regardless of timing. A plain sign-in that parked nothing (`expectedAttempt`
  undefined) never matches.
- The entry is always cleared on read, including on every rejection path.
- A 5-minute timestamp bound (`MAX_AGE_MS`) limits how long an abandoned entry lingers. It is a
  secondary defence; a TTL alone cannot close the window.
- Entries without an `attempt` are dropped, never honoured.
- The id comes from `crypto.getRandomValues` only. `randomUUID` needs a secure context, and the app
  is served over plain http on LAN addresses during field testing. There is no `Math.random()`
  fallback: if no secure source exists the caller does not park the acceptance, and the user is
  re-prompted after login, which is the safe failure direction.
