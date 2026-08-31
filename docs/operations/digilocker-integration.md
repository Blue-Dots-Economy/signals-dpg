# DigiLocker in Signals — what it does, in plain language

**Written:** 2026-08-06. Describes the code as it stands on the `feature` branch.

> Like the other files under `docs/`, treat this as a **point-in-time record**.
> If this document and the code disagree, the code wins.

---

## The one-paragraph version

DigiLocker is the Indian government's digital document wallet — the place a
citizen already holds their Aadhaar, driving licence, certificates and so on.
Signals lets a user **pull their verified details out of DigiLocker and use them
to pre-fill their Signals profile form**, instead of typing everything by hand.
It is a *convenience and data-quality feature*: fewer typos, less form-filling,
and details that came from an official source rather than from memory.

That is the whole of it. To be clear about what it is **not**:

- It is **not a login method.** You cannot sign in to Signals with DigiLocker.
  Signing in is still phone/email + OTP.
- It is **not identity verification.** Signals does not mark a profile as
  "verified" because the data arrived via DigiLocker, and does not store any
  proof that it did.
- It is **not required.** It is an optional button on the profile form. If it
  isn't configured for a deployment, the button simply doesn't appear.
- It **does not run continuously.** It is a one-time copy at the moment the user
  clicks it. Nothing syncs afterwards; later changes in DigiLocker never reach
  Signals.

---

## Where a user meets it

Exactly one place: **the profile create/edit form** (`apps/ui/src/pages/profile-form-page.tsx`).

There is an **"Import Credentials"** button above the form. It appears only when
both of these are true:

1. The form has a profile schema loaded (i.e. we know what fields to fill), and
2. At least one wallet provider is configured for this deployment.

Clicking it opens a chooser listing the available wallet providers. DigiLocker is
one; **Dhiway** (a verifiable-credential wallet) is the other. Each is listed
with a short description, and one that isn't configured is shown greyed out with
the reason. The user picks DigiLocker and the DigiLocker panel opens.

---

## What happens when the user runs it

Step by step, as the code actually behaves
(`apps/ui/src/components/wallet/providers/digilocker-provider.tsx`):

1. **User clicks "Open DigiLocker".** Signals asks a backend service (the
   "agent", see below) for a DigiLocker sign-in URL.
2. **A popup window opens** on that URL — roughly 900×700. The user signs in to
   DigiLocker and consents there, on DigiLocker's own pages. **Signals never sees
   the user's DigiLocker credentials.**
3. **DigiLocker redirects back** with a short-lived `code` — an authorization
   code, not the documents themselves.
4. **Signals notices the code.** There are three routes, which exist because
   popup callbacks are unreliable in practice:
   - *Bridge page (automatic):* a small page hosted on the callback origin
     (`docs/operations/digilocker-bridge.example.html`) reads the code and posts it back
     to the opening window. Signals is listening and picks it up.
   - *Popup polling (automatic):* every second Signals peeks at the popup's URL.
     Once the popup lands back on our own origin, Signals can read the URL and
     take the code from it. (Before that, the browser blocks reading it — which
     is expected and ignored.)
   - *Manual paste (fallback):* there is a text box. The user can paste either
     the raw code or the whole redirect URL, and Signals will pull the code out.
     There is also a "Copy launch URL" button for the case where the popup was
     blocked entirely.
5. **Signals exchanges the code for data,** again via the agent service, asking
   for a document type — **`aadhaar` is hardcoded as the default and nothing in
   the UI offers a choice**, so in practice this is an Aadhaar import.
6. **The returned details are matched onto the form fields** (see next section),
   the form is pre-filled, and the user gets a toast saying how many fields were
   filled.
7. **The user reviews and submits.** Nothing is saved until they do. The import
   only populates the form in their browser.

Timeouts and edge cases the code handles: the popup being blocked (error shown,
manual paste still offered), the user closing the popup (monitoring stops), and a
**10-minute timeout** after which it gives up with "authentication timed out".

---

## How imported details land in the right boxes

This is the genuinely clever part, in `apps/ui/src/lib/import-mapping.ts`.

DigiLocker returns data with its own field names, which won't match a Signals
network's field names. So Signals does fuzzy matching rather than requiring an
exact map:

- The incoming data is **flattened** — nested structures become simple
  `path.to.field` keys.
- Every value is registered under **several spellings at once**: the full path,
  the bare key, `snake_case`, `camelCase`, and a stripped-down form with all
  punctuation removed and lowercased. So `Date of Birth`, `dateOfBirth`,
  `date_of_birth` and `dateofbirth` all point at the same value.
- Then for each field in the profile schema, Signals looks for any of those
  spellings. A schema can also declare explicit aliases via
  `x-import-aliases` / `x-import-paths` / `x-wallet-aliases` if the automatic
  guess isn't enough.
- Types get nudged where obvious — a numeric-looking string into a number field,
  a number into a text field.

Two behaviours worth knowing, because they surprise people:

- **An import can only add or overwrite, never clear.** An empty incoming value
  is dropped rather than blanking a field the user already filled.
- **If nothing matches, the user is told.** They get "couldn't match any fields"
  rather than a silent no-op. If some matched and some didn't, the toast says how
  many were skipped.

---

## What a deployment operator needs to configure

DigiLocker is **off by default** and enabled per deployment by two build-time
environment variables for the UI:

| Variable | Meaning |
|---|---|
| `VITE_AGENT_URL` | Base URL of the "agent" service that talks to DigiLocker |
| `VITE_AGENT_TOKEN` | Bearer token Signals sends to that agent |

If either is missing, `isDigiLockerConfigured()` returns false, and the provider
is listed in the chooser as unavailable with the hint *"Missing VITE_AGENT_URL or
VITE_AGENT_TOKEN."*

**Signals does not talk to DigiLocker directly.** It calls two endpoints on the
separate agent service:

- `GET /api/v1/discover/digilocker-request` → returns the sign-in URL
- `POST /api/v1/discover/digilocker-auth` → exchanges `{ code, doctype }` for the
  document details

**This agent is not part of this repository.** The Signals API (`apps/api`) has
no DigiLocker code at all — confirmed: no route, no mention in `openapi.json`.
All DigiLocker logic lives in the UI plus that external service. So the
DigiLocker client registration, secrets and government-side agreement all sit
with whoever runs the agent, not with Signals.

For the automatic (nicest) callback path, the operator should also host the
bridge page at the callback origin DigiLocker is configured to redirect to. A
working example is kept at `docs/operations/digilocker-bridge.example.html`.
It is **not** shipped or served — it used to sit in `apps/ui/public/`, which Vite
copies to the served root, so every deployment exposed it at
`/digilocker-bridge.html` despite nothing in the app using it (#600). Read its
header comment before hosting it: the `postMessage` calls target `'*'` and must
name an exact origin first.

---

## Honest notes on the current implementation

These are real characteristics of the code today, not hypotheticals. They matter
for anyone deciding whether to switch this on.

### Known security limitations (tracked privately)

Do not switch DigiLocker on for a production deployment without a security review
first. There are known limitations in the current implementation — in how the
agent token is handled, and in how the popup callback delivers its authorization
code — that are tracked in the repo's **private Security Advisories** rather than
detailed here, because this is a public repository. The callback item also has a
public tracking issue (#504). Resolving these is the prerequisite for treating any
imported data as trustworthy.

### Aadhaar is the only document type in practice

`completeAuth(code, doctype = 'aadhaar')` — the default is never overridden, and
no UI offers a choice. Worth knowing before describing this feature as "import
your DigiLocker documents": today it means Aadhaar details.

### Aadhaar data is sensitive, and the form is the only gate

What comes back is real identity data. Signals drops it straight into the form
for the user to review, which is right — but note that whatever the user then
submits follows the ordinary profile rules from there. Which fields are private
and which are publicly discoverable is governed by the network schema's private
/ declared-field configuration, not by anything DigiLocker-specific. If a
deployment enables DigiLocker for a network whose profile fields are public, the
imported details become public once the user saves.

### It is fire-and-forget

Signals stores no record that a field came from DigiLocker — no provenance, no
timestamp, no "verified" flag. The `metadata`/`summary` the provider returns is
used only for the on-screen toast. So downstream, imported data is
indistinguishable from typed data.

---

## Where the code lives

| Path | Role |
|---|---|
| `apps/ui/src/components/wallet/providers/digilocker-provider.tsx` | The whole user-facing flow: popup, polling, message listener, manual paste |
| `apps/ui/src/lib/digilocker-api.ts` | The two agent calls, plus the config check |
| `apps/ui/src/lib/import-mapping.ts` | Fuzzy field matching onto the profile schema |
| `apps/ui/src/components/wallet/wallet-import-modal.tsx` | The provider chooser |
| `apps/ui/src/engine/wallet/wallet-registry.ts` | Small runtime registry of wallet providers |
| `apps/ui/src/engine/wallet/types.ts` | The provider contract |
| `docs/operations/digilocker-bridge.example.html` | Example callback bridge page (reference only — not shipped, not served) |
| `apps/ui/src/pages/profile-form-page.tsx` | Where the "Import Credentials" button lives |

Adding another wallet provider means calling `registerWalletProvider` with a
component and an `isConfigured` check — deliberately a deployment-level choice via
env var, **not** something a network's `network.json` selects. See
`apps/ui/src/engine/README.md`.

Test coverage for all of the above:
`apps/ui/src/components/wallet/providers/__tests__/wallet_providers.test.tsx` and
`apps/ui/src/lib/__tests__/lib_group_3.test.ts`.
