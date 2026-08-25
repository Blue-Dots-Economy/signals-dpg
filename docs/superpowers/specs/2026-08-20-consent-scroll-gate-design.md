# Standardised consent gate with scroll tracking

**Issue:** aggregator-dpg #636 — _Standardize T&C acceptance UX across the DPG_
**Date:** 2026-08-20
**Repos:** `aggregator-dpg` and `Signals-DPG` (two PRs, developed in parallel)

## Problem

Consent is captured in five places across two products, and no two behave the same way.

In Signals, clicking **Create account** opens a blocking modal: two tabs, a checkbox,
_Accept & Continue_. In the aggregator, the user ticks an inline checkbox on the form and
may optionally click a link to read the documents in a dismissible viewer. Nothing anywhere
requires the user to have reached the end of the text before agreeing.

Business has confirmed the requirement: **the user must reach the end of every document
before the agreement can be given**, and the behaviour must be identical everywhere.

That behaviour exists in neither product today. Issue #636 describes it as "reuse the
Signals popup", but the Signals popup has no scroll gating — its checkbox is enabled the
moment the modal opens. So this is new behaviour in both repos, not a port from one to the
other. The issue's Acceptance line ("Behaviour matches the Signals account-creation popup")
and its Scope line ("must scroll to the bottom") contradict each other; Scope wins, and
Signals changes too.

## Chosen design — a single guided read

Rejected: a tab per document. The aggregator's public registration form has **three**
documents, and the third is a 111-character sentence. Three tabs of visibly unequal weight
is poor, and tabs do not scale if a fourth document ever appears.

The design (validated interactively before implementation — see _Prototype_ below):

> One uninterrupted scroll containing every document in sequence, separated by rules, with
> a progress tracker pinned above it. The tracker updates continuously as the user scrolls.
> Finishing a document ticks its node and promotes the next. When every document has been
> reached, one checkbox at the foot unlocks, and with it _Accept & continue_.

No per-document checkbox. No _Next_ button. One scroll, one agreement.

### Why this shape

- **The read is uninterrupted.** Nothing to click between documents, which matters on a
  phone, and matters most for a first-time user reached by a printed QR poster.
- **The tracker earns its place.** It reports which document is in hand, what is behind,
  and how much remains — information a scrollbar cannot convey across concatenated documents.
- **The short-statement problem dissolves.** As one continuous scroll, the 111-character
  profile statement is simply the tail. It cannot be individually unscrollable, so it cannot
  lock the form (see _Failure modes_).
- **It scales.** Two documents in Signals, three on the aggregator's public form, N later —
  the tracker renders N nodes.

### Progress model

State per document is `todo → current → read`. `read` is **sticky**: scrolling back up to
re-read never un-ticks it.

A document becomes `read` when its bottom edge passes the bottom of the viewport. The
connecting line's fill is continuous, not stepped:

```
fill% = min(100, (documentsRead + fractionOfCurrentDocument) / (documentCount - 1) * 100)
```

so each completed document is worth one segment and the document in hand contributes its
own fraction of the next. The line tracks the finger rather than animating behind it.

### What is recorded — unchanged

`PublicRegistrationView.tsx` already writes three separate flags from its single checkbox:

```ts
consent_terms: consentAccepted,
consent_privacy: consentAccepted,
consent_profile: consentAccepted,
```

`MinimalIdentityForm.tsx` writes the first two. Signals builds a `pendingConsent` record
before the gate opens and the gate merely releases it.

**No storage, payload, or API change in either repo.** One checkbox releasing all flags is
today's semantics, preserved exactly. The per-document split already exists in the payload
if per-document ticks are ever wanted later; this design does not foreclose that.

## Scope

### aggregator-dpg — all four acceptance surfaces

| Surface                  | File                                            | Documents                        |
| ------------------------ | ----------------------------------------------- | -------------------------------- |
| Org registration         | `(public)/register/OrgRegisterForm.tsx`         | Terms, Privacy                   |
| Coordinator registration | `(public)/register/CoordinatorRegisterForm.tsx` | Terms, Privacy                   |
| Public QR form           | `[org]/[slug]/PublicRegistrationView.tsx`       | Terms, Privacy, Profile creation |
| Public QR minimal form   | `[org]/[slug]/MinimalIdentityForm.tsx`          | Terms, Privacy                   |

The two registration forms share `ConsentCheckboxWidget`, so they are one change. The two
public forms each hand-roll their own checkbox and modal wiring and are converted separately.

`ConsentModal` gains a `gate` mode alongside its current read-only behaviour. Existing
`view`-mode callers are untouched: opening the documents from a link must keep working
exactly as now.

The inline "Terms & Privacy Consent" block is **removed** from the registration forms. The
`consent` block is stripped from the client-side schema before RJSF renders it — following
the existing `stripFormChrome` pattern — so it neither renders nor blocks the submit button.
The gate supplies the value at submit time.

**No JSON schema file changes.** `consent` is `required` with `consent.value` required
inside it across 10 schema files in 6 config trees, and the API validates against them
server-side. The payload still carries `consent.value: true`. Weakening a server-side
guarantee to accommodate a UI change is not acceptable.

**No API change**, therefore no `openapi.json` regeneration.

### Signals-DPG — all four gate call sites

`apps/ui/src/components/consent/consent-modal.tsx` is shared by:

- `pages/auth/login-page.tsx`
- `pages/auth/oidc-callback-page.tsx`
- `pages/auth/keycloak-login-panel.tsx` (account creation)
- `components/consent/u18/guardian-form-step.tsx` (guardian consenting for a minor)

All four receive the behaviour. One component, one behaviour, which is the point of the
issue. `mode: 'view'` is unaffected.

The U18 guardian flow is legally sensitive and has existing mobile-drawer tests
(`u18-guardian-flow.mobile.test.tsx`) asserting that a clipped submit button and the logout
escape hatch stay reachable. Those must stay green.

### Out of scope

- Recording consents separately per document.
- The `profileCreation` statement's own bespoke modal in `PublicRegistrationView` — folded
  into the guided read on that surface, not redesigned independently.
- Any change to consent versioning or the `consent.json` config format.
- Any consent capture on the public legal pages — they are read-only.
- Linking from the gate to the public pages. The gate stays self-contained.

## Public legal pages

Separate from the gate, and deliberately so: the gate is a blocking step inside account
creation, the public pages are a calm reference anyone can read at any time with no
commitment attached. **The gate does not change** — it still opens automatically during
account creation and carries no link away from itself.

### Layout — a contents rail

A persistent rail lists every document and every section within it; the reading column sits
alongside. Chosen over a document switcher or a single stacked page because it is the only
one of the three that makes each _section_ reachable in one click and deep-linkable, and the
only one that absorbs more documents without redesign. On narrow screens the rail collapses
above the reading column rather than beside it.

Each document shows its **version and effective date**, both already carried in
`consent.json` and surfaced nowhere in the product today.

No checkbox, no agreement, no scroll gating. These pages capture nothing.

### Routes — two, sharing one component

`/privacy` and `/terms` in both products. Not one combined URL:

- Signals' `/privacy` and `/terms` already exist and may be linked from Keycloak emails or
  external references. Collapsing them is risk with no gain.
- They are the conventional URLs for legal documents.
- With a contents rail, switching document navigates to the other route, so the address bar
  always matches what is on screen. Section anchors deep-link — `/privacy#retention`.

### Signals-DPG — mostly a repair

`apps/ui/src/pages/legal/privacy-page.tsx` and `terms-page.tsx` already exist, already render
the config-sourced Markdown, and already carry the language and theme controls.
`privacy-page.tsx` even documents that it is _"reachable straight from the auth footer"_ —
but `auth-footer.tsx` opens the read-only `ConsentModal` instead of navigating. The link was
never wired.

Work: give both pages the contents-rail layout via a shared component, and change the auth
footer's "Privacy Policy" and "Terms" from modal triggers to router links. The footer's
sentence ("By continuing you agree to…") is unchanged.

### aggregator-dpg — new routes, rail grouped by audience

No `/privacy` or `/terms` route exists today. Both are new under the existing `(public)`
route group.

The aggregator carries **three** audiences of consent document, unlike Signals' one:

| Audience      | Source                                              | Seen by                     |
| ------------- | --------------------------------------------------- | --------------------------- |
| `aggregator`  | `config/schemas/aggregator/consent.json`            | a coordinator registering   |
| `org`         | same file, `org` section                            | an organisation registering |
| `participant` | `config/<network>/schemas/participant/consent.json` | anyone scanning a QR poster |

So `/privacy` alone is ambiguous. The rail resolves it by grouping: **For participants**,
**For aggregators**, **For organisations**, each listing that audience's sections. One pair
of URLs, every document reachable, nothing hidden behind a query parameter.

Accepted trade-off: a seeker arriving from a poster will see that operator-facing terms
exist. They are public documents either way, and an over-complete legal page is a smaller
problem than an ambiguous one.

## Mobile

Both products' consent surfaces are reached predominantly on phones — the aggregator's
public form is reached by scanning a printed poster. Mobile is a primary target, not a
responsive afterthought.

- **Signals renders the gate as a vaul `Drawer` on mobile**, not a dialog. The scroll
  container differs, and `responsive-dialog.tsx` documents that `dismissible={false}` — not
  the guard callbacks — is what actually blocks swipe/backdrop/Esc dismissal there. Gate
  mode must keep passing it.
- The tracker is pinned above the scroll region and must not scroll away.
- Bottom-detection tolerance must absorb fractional device pixel ratios and iOS momentum
  overscroll, where `scrollTop + clientHeight` can fall a pixel short of `scrollHeight`.
  Detection is tolerance-based, never exact equality.
- Both breakpoints get manual verification before the PRs are marked ready.

## Failure modes designed against

**A document too short to scroll.** The profile-creation statement is 111 characters. A
naive scroll-to-bottom rule leaves its checkbox locked forever and makes registration
impossible on every network. Content shorter than its viewport counts as read on open. The
guided read makes this structurally unreachable for the aggregator's three documents, but
the guard stays for the case where _all_ documents together are shorter than the viewport —
plausible on a desktop with brief policies.

**Re-render on scroll.** Rebuilding the sheet on every scroll event resets `scrollTop` and
fights the user. The tracker is mutated in place; the reading surface renders once.

**Late layout shifts.** Web-font swap, async Markdown render, and orientation change all
alter scroll geometry after first paint. Completion is re-evaluated on resize, not only on
scroll.

## Testing

Mirrored case-for-case across both repos, so a future change to one surfaces as a failing
test in the other. The two products share no code; only the tests hold them together.

- Checkbox is disabled on open and stays disabled while documents remain unread.
- Scrolling to the end of each document ticks its node and promotes the next.
- The final document completing enables the checkbox; ticking it enables the CTA.
- Read state survives scrolling back up.
- Content shorter than the viewport counts as read immediately — the 111-character case.
- Gate mode: Esc and outside click do **not** dismiss. Signals additionally: the mobile
  drawer cannot be swiped away.
- `view` mode is unchanged and still dismissible.
- aggregator: each of the four surfaces submits `consent.value: true` (registration) or the
  three/two consent flags (public forms) after the gate is accepted.
- Signals: the existing U18 guardian mobile-drawer tests stay green.

## Delivery

Two PRs, developed in parallel, each opened as a **draft**.

|             | aggregator-dpg                 | Signals-DPG                    |
| ----------- | ------------------------------ | ------------------------------ |
| Base branch | `feature`                      | `feature`                      |
| Branch      | `feat/636-consent-scroll-gate` | `feat/636-consent-scroll-gate` |

A freshly-created worktree must run `pnpm --filter "./packages/*" build` before the web
suite will pass: several app imports resolve to workspace `dist/` subpaths
(`@aggregator-dpg/config-loader/fs`, `@aggregator-dpg/network-config/signals-cta`,
`@aggregator-dpg/shared-primitives/url`) that do not exist until the packages are built.
Without it, seven suites fail to collect and the failure looks like a code regression.

Conventional Commits; husky/lint-staged runs on commit and is never bypassed. Each PR
description carries an **In Plain Terms** section. aggregator additionally runs
`pnpm dep-check` as a required CI step. Test runs are scoped per-package — running the full
monorepo suite at parallelism on this machine produces intermittent unrelated timeouts.

Both PRs link back to this spec so the behaviour contract has one home.

## Prototype

Four interaction models were built and trialled interactively before this design was
settled: guided steps, accordion, one continuous read, and a checklist. The chosen design
combines the reading model of the continuous read with the tracker of the guided steps.

Committed alongside this spec so the reasoning is reviewable without a local file:

- `docs/superpowers/prototypes/2026-08-20-consent-gate-approaches.html` — approach E is the
  chosen one, marked as such; the four rejected models are kept so the choice is auditable.
- `docs/superpowers/prototypes/2026-08-20-public-legal-page-approaches.html` — approach B is
  the chosen contents-rail layout.

Both use the real copy from `config/blue_dot/schemas/participant/consent.json`. Neither is
shipped code.

## Open items

None blocking. Two things to keep visible during review:

- **Scroll position evidences reaching the end, not reading it.** No interface can prove
  comprehension. This is a good-faith gate and should not be described as a compliance
  guarantee.
- **#636's Acceptance line is inaccurate** — Signals does not have this behaviour today. The
  issue should be corrected so the discrepancy is not re-raised later.
