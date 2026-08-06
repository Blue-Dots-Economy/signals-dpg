# Feedback: Keycloak migration — realm topology & signals user identity

**To:** Author of the Keycloak migration plan · Architect
**From:** Aniket
**Date:** 2026-07-29
**Re:** `docs/superpowers/plans/2026-07-23-keycloak-migration-design.md` (branch `docs/keycloak-migration-design`)
**Related:** `docs/superpowers/specs/2026-07-17-iam-actor-action-register.md` and `2026-06-29-iam-architecture-fork-centralized-vs-federated.md` (branch `feat/keycloak-migration`)

First — the plan is solid on the mechanics: the phased/reversible `AUTH_PROVIDER` rollout, keeping the local `user` table as a UUID-preserving mirror to protect the `items.created_by` RESTRICT FK, and the `x-api-key` → client-credentials move are all the right calls. This note is about **one foundational decision** plus a coverage check against the actor register.

---

## The ask (one decision)

**Drop the shared `bluedots` realm. Give signals its own per-instance realm; leave aggregator in its own.**

This resolves two problems that are actually the same root, and keeps the door open to the actor-register model.

---

## Two concerns, one root cause

The updated plan puts signals **and** aggregator in a single per-instance realm (`bluedots`), so a human has **one `sub` across both DPGs**. That single choice causes both of the following:

**1. It restricts something product never asked to restrict.**
A shared realm makes `email`/`phone_number` unique across *both* populations. So the same person **cannot** register separately on aggregator and on signals — they collapse into one account. **There is currently no product requirement to unify or restrict this.** We're baking in a constraint nobody requested.

**2. It breaks the "copy signals users as-is" migration.**
This is the plan's own **§6.3 spike 2**: a signals participant whose email/phone already exists as an aggregator user *already has an aggregator `sub`*, so they **cannot** be created with signals' preserved UUID — and their `created_by` rows can't be rewritten (§2.3). The collision exists **only because** the realm is shared.

Give signals its own realm and **both** disappear: same email/phone can exist independently in each realm, and every signals UUID copies over cleanly with zero collisions.

---

## The tradeoff (accept it consciously)

Separate realms mean **no shared `sub` across the two DPGs**. Any future cross-DPG identity linking (e.g. an ecosystem-wide consent record keyed on a common subject) would need Keycloak identity brokering or an ecosystem user-mapping layer.

**Product has not asked for cross-DPG identity unification either.** So this is a fair deferral, not a lost capability — and it's reversible (brokering can be added later without re-doing the migration).

> Note: the actor register (§9) originally leaned toward putting aggregator clients inside the instance realm — i.e. the shared-realm direction. Given the "no product ask to restrict" point above, we should revise the register toward **separate realms per DPG**. Flagging so the register and this plan stay consistent.

---

## Coverage check against the actor register

Separate from the realm decision, here's what the plan does / doesn't cover against `2026-07-17-iam-actor-action-register.md`. Most gaps are legitimate scope deferrals — listing them so we agree on what's in vs out.

| Register scenario | In this plan? |
|---|---|
| Participant login (seeker/provider/both), OIDC | ✅ Yes |
| Per-DPG service auth (retire shared key) | ✅ Yes |
| **Same phone/email on both DPGs, independently** | ❌ Prevented by shared realm — *the ask above* |
| Copy signals users preserving UUID | ⚠️ Intended, but collides under shared realm (spike 2) |
| **Aggregator = operating unit, Coordinator = member** (decoupling → multi-user RBAC) | ❌ Not handled — org/member stay local, `x-acting-org-id` stays |
| `acting_org` as a **token claim** (not a client header) | ❌ Not handled |
| **On-behalf-of mandatory** for user data (Raya / campaign / aggregator acting for a human) | ❌ Not handled — service identity + declared subject only |
| **OPA** as policy engine + item-level ownership + item/action consent gating | ❌ Not addressed — authz stays `organization.type` |
| Cross-instance peer + **network registry** | ❌ Out of scope (plan Q8; per-instance realm = no shared issuer) |
| Future tiers: Guardian/Proxy, Org Admin, Aggregator Admin | ❌ No seam yet |

The bottom four are reasonable to defer — but the **separate-realm decision keeps them all implementable later**, whereas the shared realm quietly forecloses the clean path to decoupling and claim-based `acting_org`.

---

## Other conflicting / missing decisions

Beyond the realm question, several decisions in the plan conflict with, or predate, choices already locked in the working IAM specs (esp. the `2026-07-22` pending-decisions doc, which resolves D1–D8 + engineering E1–E5). Worth a reconciliation pass:

| # | Plan's position | Already decided elsewhere | Ref |
|---|---|---|---|
| 1 | Decrypt/ownership authz keyed on **`user.onboarded_by_org_id`** (account-level) | **D1: ownership is item-level.** Aggregator gets create-if-absent + read on the *account*, CRUD only on *items it onboarded* (`acting_org` match). No aggregator account update/delete. | `2026-07-22 §4.1` |
| 2 | Service auth = client-credentials + client **names the subject**; no delegated proof/tagging | **D7: mandatory actor tagging** (`performed_by` bot + `on_behalf_of` participant); OPA `delegation_valid = on_behalf_of == session-verified-phone-subject`. Bot may not act for arbitrary users. | `2026-07-22 §4.7`, register §3 |
| 3 | `x-acting-org-id` **header stays**; authz = `organization.type` gating | **`acting_org` = token claim**; authz = **OPA** over a role×action matrix (D3) + item ownership. | register §3/§8, `2026-07-22 §4.3` |
| 4 | Peer auth **out of scope / open (Q8)**; notes per-instance realm = no shared issuer | **D5 answers it:** peer = **KC network-registry client + `network:federate`**, validated locally via JWKS; harden peer auth to parity now. | `2026-07-22 §4.5`, register §6.D |
| 5 | Retire `x-api-key` via manually-created per-DPG KC clients | **E2:** design a **service-credential issuance/rotation interface** (request → network-admin approve → issue → rotate/revoke). The manual path doesn't fully retire the shared-key problem. | `2026-07-22 §4.9` |
| 6 | Migration = **preserve UUID** (`sub == user.id`); Q7 is a translation-column fallback | **E3** describes the primary as a **legacy-id → `sub` translation column, no big-bang.** Same track — reconcile which is primary (the plan *is* the detailed E3). | `2026-07-22 §4.9`, `keycloak-migration-design §4` |
| 7 | Token transport **open (Q4)**; Build 2 assumes `localStorage` | Our earlier design chose the **BFF** (OIDC on signals-api, httpOnly cookie + Redis, tokens never reach the browser). | `keycloak-migration-design §6` |
| 8 | Consent untouched (out of scope) | **E5:** consent gates at **initiate *and* accept** (currently accept-only); **E4:** item live→paused/draft lifecycle affects in-flight actions. Dependency, not a conflict — but the realm/`sub` choice affects consent keying. | `2026-07-22 §4.9`, connect-flow-consent |

None of these need to be *built* in this plan — but the plan should **state which it defers vs. contradicts**, so it doesn't quietly foreclose D1/D3/D5/D7 (all of which assume item-level ownership, a token-claim `acting_org`, OPA, and a network registry).

## Working specs to reconcile against

The plan cites only `2026-06-25-keycloak-migration-design.md` + the consent-minimal doc. The IAM design has moved on since — please read/reconcile against the specs dated **2026-06-25 or later** here:

**https://github.com/Blue-Dots-Economy/signals-dpg/tree/feat/keycloak-migration/docs/superpowers/specs/**

- `2026-06-25-iam-auth-open-questions-for-product.md` — the product Q&A register.
- `2026-06-25-keycloak-migration-design.md` — the original migration design (the plan is its detailed successor). **Note:** its realm premise was **superseded** by the fork below.
- `2026-06-29-iam-architecture-fork-centralized-vs-federated.md` — **the A-vs-B fork; chose B1 (per-instance realms).** Directly relevant to the realm-topology ask above.
- `2026-07-08-multi-instance-iam-design.technical.md` — multi-instance identity, cross-instance trust, the network registry.
- `2026-07-17-iam-actor-action-register.md` — **canonical actors/actions + KC/OPA modeling** (the doc the coverage table checks against).
- `2026-07-17-network-functional-business-usecases.md` — the non-technical functional baseline.
- `2026-07-22-iam-pending-decisions-for-product.md` / `2026-07-22-iam-pending-decisions.technical.md` — **the locked D1–D8 + E1–E5 decisions** the table above cites.

The three that most affect this plan: the **fork** (realm topology), the **actor register** (target model), and the **pending-decisions technical** doc (D1/D3/D5/D7 + E2/E3).

## Decisions we need

1. **Realm topology:** shared `bluedots` realm vs **one realm per DPG, per instance** (our recommendation: per-DPG).
2. **Confirm the product premise:** is a person allowed to register independently on both aggregator and signals with the same phone/email? Our read is **yes, and there's no ask to restrict it** — which is the deciding factor. If product actually *wants* one identity across DPGs, the shared realm becomes justified and we revise the register instead.

Happy to walk through it live.
