# Consent-point registry — adding and removing consent points as configuration

**Issue:** [#372](https://github.com/Blue-Dots-Economy/signals-dpg/issues/372) — Consent-point registry (epic [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99))
**Date:** 2026-07-27
**Status:** Design — pending review.

**Related:**
- `2026-07-27-consent-version-upgrades-design.md` — versioning, notice windows, `event`, `consentStatus`. That spec makes a *version bump* work; this one makes a *new consent point* cheap.
- `2026-07-27-consent-external-channels-design.md` — hands the profile-update consent point (#367 §3) to this spec.
- `2026-06-25-consent-management-design.md` — the eventual `consent-service`. §4.1 of that design keys documents on a **scope key** (`network` + `audience` + `doc_type` + `action_type?` + `action_status?` + `channel?`). The registry defined here is deliberately shaped as that same scope key expressed in config, so migration is a data move rather than a redesign.

---

## 1. Problem

Adding one consent point today is an eight-file change across two repos.

The document set is a **closed Zod object**, not an open record:

```ts
documents:     { terms, privacy, profile_creation }
u18_documents: { terms, privacy, profile_creation, guardian_declaration }
```

So a new point — #364's "new purpose" (adult #4, minor #5), "data transfer to a government custodian" (adult #5), or #367's profile-update consent (§3) — requires edits to: `packages/schemas/src/consent_config.ts` (both the full and `Partial` schemas), `ConsentDocumentCategory` in `services/consent_version.ts`, `UserConsentCategorySchema` in `packages/schemas/src/api/consent_schemas.ts`, the hardcoded `inArray(consentCategory, ['terms','privacy'])` in `get_consent_status.ts:56`, `ConsentStatusResponseSchema`, the hardcoded `['terms','privacy']` in `hooks/use-consent-gate.ts:54`, `ConsentModal`'s hardcoded privacy/terms tabs, and a new gate call site.

Two structural problems sit underneath that cost:

**Gates are hardcoded call sites, not a registry.** Consent is enforced independently at `create_item`, `accept_profile_consent`, `perform_action`, `update_action_status`, two promotion paths in `item_service`, and `/admin/participant`. Nothing enumerates them. `.claude/rules/consent-v1.md:45` records the consequence: **#311** was a bypass where a new go-live path read consent presence directly and skipped the guardian gate. Every new flow point is another chance to repeat that.

**The action-consent trigger lives in a different file from the statement.** Whether action consent is *required* is decided by `interaction.reveals_pii_on_status.length > 0` in **network.json** (`perform_action.ts:184`), while the statement lives in **consent.json**. They can silently disagree in both directions: a configured statement with no `reveals_pii_on_status` is never shown; a `reveals_pii_on_status` with no statement fails `CONSENT_VERSION_UNCONFIGURED` at commit time — and in `update_action_status` that rolls back the status change. §6 of the cross-DPG design already called for this rework; it was never done.

**Only the `actions` record is extensible today.** A new action consent point genuinely is config-only, because `actions` is `z.record(z.string(), ...)` and `resolveConsentVersion` reads it by string key. That proves the shape works — it just needs to apply to every level.

## 2. Design

### 2.1 The registry

Replace the three closed objects with one open, keyed record:

```jsonc
{
  "consent_points": {
    "user_terms": {
      "level": "user",
      "doc_type": "content",
      "required_at": ["signup", "login"],
      "current_version": 1,
      "versions": [ { "version": 1, "title": "…", "content": "…", "effective_from": "2026-01-01" } ]
    },
    "user_privacy":     { "level": "user", "doc_type": "content",   "required_at": ["signup", "login"], "versions": [ … ] },
    "profile_creation": { "level": "item", "doc_type": "statement", "required_at": ["item_create", "item_go_live"], "versions": [ … ] },

    // (#367 §3) — previously impossible without code
    "profile_update":   { "level": "item", "doc_type": "statement", "required_at": ["item_update"], "versions": [ … ] },

    // (#364 adult #4 / minor #5) — a purpose beyond the original disclosure
    "talent_heatmap":   { "level": "user", "doc_type": "statement", "required_at": ["explicit"], "versions": [ … ] },

    // (#364 adult #5) — transfer to a government custodian / partner NGO
    "data_transfer_custodian": { "level": "user", "doc_type": "statement", "required_at": ["explicit"], "versions": [ … ] },

    "connect_initiate": {
      "level": "action", "action_type": "connect", "stage": "initiate",
      "doc_type": "statement",
      "required_at": ["action:connect:initiate"],
      "reveals_pii": true,
      "versions": [ … ]
    }
  },

  "variants": {
    "u18": {
      "user_terms":            { "versions": [ … ] },
      "user_privacy":          { "versions": [ … ] },
      "profile_creation":      { "versions": [ … ] },
      "guardian_declaration":  { "level": "user", "doc_type": "statement", "required_at": ["guardian_capture"], "versions": [ … ] }
    }
  }
}
```

The point **key is the ledger's `consent_category`**, which is already `text`. So no ledger migration is required and historical rows keep resolving.

`level` and the action dimensions are exactly the cross-DPG design's scope key. `variants` replaces `u18_documents` and generalises it — a third variant needs no schema change.

### 2.2 `required_at` is the trigger — a closed enum of hook points

This is the crux. The **points** are open; the **hook points** are closed and implemented once:

| hook point | fires at |
|---|---|
| `signup` | account creation (self-signup and provisioning) |
| `login` | present turn — the re-consent / notice gate |
| `item_create` | `create_item` |
| `item_update` | item field update — **new**, delivers #367 §3 |
| `item_go_live` | promotion to `live` |
| `action:<type>:<stage>` | `perform_action` (`initiate`) / `update_action_status` (`accept`) |
| `guardian_capture` | the U18 guardian flow |
| `explicit` | never auto-gated; captured only by a deliberate prompt |

Adding a consent point is configuration. Adding a *new kind of hook point* is code — which is honest, because it is a genuinely new place in the product, and it is a one-line addition to the enum plus one call site rather than an eight-file spread.

`explicit` is what makes #364's "new purpose" scenarios tractable: `talent_heatmap` is never a blocking gate, it is a prompt shown when the feature is offered, and `consentStatus` reports whether it is held. That matches DPDP's requirement that a new purpose needs fresh, purpose-specific consent rather than being bundled into terms.

### 2.3 One gate helper

```ts
requireConsent(hookPoint: HookPoint, ctx: GateContext): Promise<GateVerdict>
```

`GateContext` carries `{ userId, network, brand, variant, itemId?, actionType?, stage? }`. The verdict lists unsatisfied points with their `PointStatus` (from the versioning spec's `consentStatus`).

Every current call site becomes a `requireConsent` call. The helper resolves which points apply from the registry — callers never name a category.

**The bypass test.** A table-driven test asserts that for every value of `HookPoint`, a wired call site exists, and that a registry point declaring `required_at: ["item_go_live"]` is enforced on **both** promotion paths (`item_service.ts:441` and `:614`). This is the structural answer to #311: forgetting a gate becomes a failing test rather than a silent PII leak.

`guardianGateBlocksGoLive` remains **the** single source of truth for the age gate and is called from `requireConsent`'s `item_go_live` path, never re-derived. This spec changes how consent points are discovered; it does not add a second age check.

### 2.4 `reveals_pii_on_status` stops being the trigger

Action-consent requirement moves wholly into the registry. `reveals_pii_on_status` stays in `network.json` as the **PII-disclosure declaration** it should be — the statement of *what* a status transition discloses — and no longer decides *whether* consent is gathered.

Migration: for each interaction currently declaring `reveals_pii_on_status`, generate the corresponding `consent_points` entry with `required_at: ["action:<type>:<stage>"]` and `reveals_pii: true`. A validation check reports any interaction with `reveals_pii_on_status` and no matching registry point (previously a runtime failure at commit), and any action point whose interaction does not declare disclosure (previously a statement that was never shown).

Per `feedback_network_config_source_of_truth.md`, both files are edited in Signals `examples/schemas/` first; the automation copy and ConfigMap are a downstream sync.

### 2.5 Category-generic API and UI

- `/consent/status` returns `{ points: { <key>: PointStatus } }` — the shape the versioning spec already introduces. The hardcoded `inArray(…, ['terms','privacy'])` filter is removed; the query is driven by the registry.
- `UserConsentCategorySchema` becomes `z.string()` validated against the loaded registry, rejecting unknown keys with a machine-readable error rather than a Zod enum failure.
- `useConsentGate` iterates the registry instead of `['terms','privacy']`, splitting on `needs_consent` (blocking) vs `offer_pending` (notice).
- `ConsentModal` renders one tab per `doc_type: "content"` point returned by `/consent/active`, rather than two hardcoded tabs. Statement-type points render inline as checkbox copy, as they do now.

### 2.6 Retirement, not deletion

Removing a point sets `"retired": true`. Retired points are never gated, never offered, and never re-consented — but they still **resolve** for status reads and audit, because the ledger holds historical rows under that key. Deleting the key outright would make `consentStatus` error on a user's own history.

A retired point's existing acceptances remain valid evidence of what was consented to at the time. This is the ledger-truthfulness principle the cross-DPG design applies to bulk onboarding (§4.5), applied to removal.

## 3. Migration

**Config transform.** Mechanical, scripted:
- `documents.terms` → `consent_points.user_terms` with `required_at: ["signup","login"]`
- `documents.privacy` → `consent_points.user_privacy`, same triggers
- `documents.profile_creation` → `consent_points.profile_creation` with `required_at: ["item_create","item_go_live"]`
- `u18_documents.*` → `variants.u18.*`
- `actions.<type>.<stage>` → `consent_points.<type>_<stage>` with the action dimensions and `required_at: ["action:<type>:<stage>"]`

Six `consent.json` files across the two repos (`blue_dot`, `orange_dot`, `purple_dot`, `yellow_dot`, plus `blue_dot/upsdm` and `orange_dot/onetac` brand overrides).

**Compatibility loader.** `packages/config` accepts either shape for one release, normalising the old form into the registry in memory. Lets the config sync and the code deploy independently, which matters because deployed `consent.json` lives in a ConfigMap rendered from `bluedots-automation`.

**Ledger.** No migration. `consent_category` is already `text` and the transform preserves key names for the three existing user/item points. Action rows already store `action_type` + `action_stage` separately.

**Brand overrides.** The `PartialConsentConfig` shape becomes "any subset of registry keys", which is naturally partial and removes the hand-maintained parallel `PartialU18Documents` object. This also removes the class of bug where a brand merge silently drops a whole section — the `u18_documents` drop in `hooks/use-consent-config.ts:12` exists precisely because the merge enumerates keys by hand.

## 4. Testing

**Pure/unit** — registry parsing and validation (unknown `level`, unknown `required_at`, action point missing `action_type`/`stage`, `retired` point rejected from `required_at` resolution); the old→new config transform over all six real files; the compatibility loader accepting both shapes and producing identical registries; brand-override merge preserving every section including variants.

**Gate coverage** — the table-driven test that every `HookPoint` has a wired call site; `item_go_live` enforced on both promotion paths; a newly added config-only point being enforced with **zero code changes** (the acceptance test for this whole spec).

**Integration** — `profile_update` blocking an item update until accepted (#367 §3); an `explicit` point never blocking anything but reporting status correctly (#364 adult #4); a retired point resolving for history but never gating; an action point migrated off `reveals_pii_on_status` behaving identically to before.

**Regression** — the #311 scenario: a promotion path that reads consent presence directly must fail the coverage test.

## 5. Out of scope

- Versioning, notice windows, revoke, expiry → the versioning spec. This spec assumes `consentStatus` and `PointStatus` exist.
- The aggregator's own `AggregatorConsentConfigSchema` (`audiences.{org,aggregator}.documents`) stays as-is. Converging the two config schemas is a migration-issue item — doing it here would couple two repos' releases for no near-term gain, since operator consent has one audience shape and no action or item levels.
- Consent receipts, DPV purpose vocabulary, DEPA artefacts. The registry reserves room for them (a point can carry `purpose` / `data_captured`) but populating them is a migration-issue item.
