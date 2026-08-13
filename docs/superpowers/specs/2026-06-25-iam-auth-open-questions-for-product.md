# IAM & Auth — Product Q&A Register (Signals + Aggregator)

**Date:** 2026-06-25 · **Last updated:** 2026-06-29 (product responses folded in)
**For:** Product Manager · **From:** Engineering (auth/IAM design)
**Scope:** Signals-DPG + aggregator-dpg only. (ai-diffusion / voice service reviewed later.)

## Why this document

We're designing the **shared identity & access layer** for the network — *who you are* (login) and *what you're allowed to do* (permissions) across Signals and the Aggregator. It's the prerequisite for the **consent/T&C** work, for fixing **cross-instance actions**, and for tightening **PII access**.

The technical shape is determined by **policy choices that are product's to make**. This document tracks each question, product's response (from any source), engineering's read of whether it actually answers the question, and the resulting follow-up.

---

## How to read this register

Each question carries a **status**:

| | Meaning |
|---|---|
| ✅ | Answered — clear, actionable, no conflict |
| 🟡 | Partial — answered in part; detail still needed |
| 🔶 | Answered-but-conflicts — the answer contradicts a design premise or another answer; needs reconciliation |
| 🔴 | Open — not yet answered |
| ↩️ | Bounced — product asked a question back at engineering |

**Response sources** (responses now arrive in several places — consolidated here):

- **[QD]** — inline answers in this questions doc (PM, 2026-06-29)
- **[#99]** — consent issue [signals-dpg#99 comment](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99#issuecomment-4835555485) (2026-06-29)
- **[RBAC]** — [Aggregator Org Roles & Configurable Forms](https://docs.google.com/document/d/1pL7_A8w8Z3P1JO2R-bUpVjRJcoy2-AXoFt0kghyU_s4/edit) gdoc
- **[IAM]** — [IAM and Data Handling — Business Cases](https://docs.google.com/document/d/1EqNU2Jcs0vW8NTpdfmqOLiwKPWht7SFxETeLftgnq54/edit) gdoc

---

## Premise ledger (impact on the design's P1–P4)

The Keycloak design (`2026-06-25-keycloak-migration-design.md` §2) is built on four provisional premises. Product's answers resolve them as:

| Premise | Design assumed | Product's answer | Verdict |
|---|---|---|---|
| **P1 — Identity scope** | one person = one `sub`, network-wide, single realm | register **per instance**; same phone = separate account per instance; no dedup (QD 1.1, 1.4, 9.3) | ❌ **Rejected** |
| **P2 — Cross-instance** | discovery + action in scope, honored network-wide | discoverability network-wide **yes** (QD 1.2); cross-instance *action* still eng-to-decide (§6 unanswered) | 🟡 **Partly confirmed** |
| **P3 — Roles** | participant = seeker **XOR** provider (mutable) | a user can be **both** seeker and provider on the **same account**; gate is **configurable per instance** (QD 2.1, 2.3) | 🔄 **Revised** |
| **P4 — Multi-domain** | blue+purple in one realm, one identity | blue+purple co-deploy "highly unlikely"; identity is per-instance anyway (QD 1.3, 1.4) | ❌ **Rejected** |

**Consequence:** the single-realm / one-`sub` foundation under both the Keycloak and consent designs no longer holds. See the **architecture fork** note (`2026-06-29-iam-architecture-fork-centralized-vs-federated.md`) — it must be resolved before either spec is finalized.

---

## 1. Identity uniqueness & scope

### 1.1 — Does a person register once for the whole network, or once per instance?
- **Status:** 🔶 Answered-but-breaks-premise (P1)
- **Response [QD]:** "Per instance. Users typically want to register across multiple instances/websites and even the operators who run instances would want a copy/host the user details with themselves."
- **Corroborated by:** [IAM] S1/S2 (per-instance registries); QD 1.4; QD 9.3.
- **Eng read:** Rejects P1 (one `sub`/network). Identity store is **per-instance**, not network-central. This is *the* fork — it collides with the consent design keying on one global `sub`.
- **Follow-up → product:** If accounts are per-instance (1.1) **but** must be network-discoverable (1.2), who mints the network-wide participant identifier and where does it live? Is that the "network facilitator" of 1.4 — and is it the same central service as our consent service?

### 1.2 — Discoverable across all instances from a single registration?
- **Status:** ✅ Answered
- **Response [QD]:** "Yes, a user registered on any one instance must be discoverable across the network."
- **Eng read:** Confirms network-wide discovery is required. Combined with 1.1 (per-instance accounts) this **forces a federation layer** — a per-instance account cannot be discovered network-wide without a shared index/identifier. [IAM] answers the *how*: central routing index (PID → instance) + central match index.
- **Follow-up → product:** none (it's now an engineering design problem — see fork note).

### 1.3 — blue + purple co-existing on one deployment: one identity or two?
- **Status:** 🔶 Reframed (answered a different question)
- **Response [QD]:** "Highly unlikely scenario. What can happen is within a network there might be different *types of profiles*, i.e. in a purple-dots network a profile for a job seeker."
- **Eng read:** Product reframed "two networks on one instance" → "multiple profile types within one network," conflating *network* with *profile/domain*. The original question (multi-network co-tenancy) is effectively declared **out of scope** — matches [IAM] S3 "Out of Scope." Useful: confirms we don't need multi-network-single-instance now.
- **Follow-up → product:** none — treat multi-network-on-one-instance as out of scope (confirm).

### 1.4 — Are *core* attributes (name, phone…) common across network/domain/instance (Beckn v2 direction)?
- **Status:** ✅ Answered (and it defines the federation model)
- **Response [QD]:** "No. Registry is per instance in network, so a user can register many times/places, no need to deduplicate. Other than PII (Name, Phone, Email), the only common attributes are Unique IDs pertaining to that network, handled by the **network facilitator implementing their own SSO**."
- **Eng read:** This is the clearest statement of product's model: **per-instance registries, no dedup, a Network Facilitator (NF) owns a network-wide unique ID via its own SSO.** Directly rejects P4 and the single-realm shape. Matches [IAM]'s NF + PID registry.
- **Follow-up → product:** Is "network facilitator SSO" a product-owned component we integrate with, or something we (engineering) build? What standard (Beckn registry? OIDC federation?)? This determines whether Keycloak is the NF or sits behind it.

---

## 2. Seeker / Provider exclusivity

### 2.1 — "Seeker OR provider, never both" — permanent, or switchable?
- **Status:** 🔄 Revised (P3)
- **Response [QD]:** "Have a gate that is **configurable per instance**. Use cases of a user being **both** seeker and provider at the same time are also possible now."
- **Eng read:** Not XOR. Model **multi-role on one account** from day one; the exclusivity gate is an **instance config flag**, not a hard rule.
- **Follow-up → product:** see new follow-up F5 (how both-roles maps to items + self-match avoidance).

### 2.2 — Same for aggregators (seeker-type OR provider-type)?
- **Status:** ✅ Answered
- **Response [QD]:** "The Org can contain **both** seeker and provider coordinates under them — no gating there. But for **coordinators**, have a configurable gate (both cases possible now)."
- **Eng read:** Org = no role gate (carries both). Coordinator = per-instance configurable gate, same as participants (2.1).

### 2.3 — Could one person/org legitimately need both roles?
- **Status:** ✅ Answered
- **Response [QD]:** "Yes — as in 2.1, a user can be both seeker and provider on the **SAME account**."
- **Eng read:** Reinforces 2.1. Note tension with one-account-many-profiles (4.4, 9.3): is "both roles" one dual-role profile or two profiles? → F5.

---

## 3. Aggregator organisation, roles & approvals

### 3.1 — Confirm the two-level approval chain
- **Status:** ✅ Answered ([RBAC] authoritative)
- **Response [QD]:** "Yes, refer to [RBAC doc]. There might be scope for an **Org Admin** between Org Owner and Coordinator. The same coordinator can register for multiple organizations."
- **Response [RBAC]:** Owner registers → **Network Admin** approves → org created (Owner auto-assigned) → Coordinator registers → **Owner** approves → Coordinator active. Rejection at either gate clears the request and allows re-application. (Phase 2: Owner may delegate Coordinator approval to Admin.)
- **Eng read:** Confirms P3's operator chain, plus **a coordinator can belong to multiple orgs** (many-to-many membership — affects the group/membership model). Open in [RBAC]: "Do we need to block coordinators or admins?"

### 3.2 — Roles inside an org + capability catalogue
- **Status:** 🟡 Partial ([RBAC] gives the roles; capability matrix still thin)
- **Response [QD]:** "The three: **Org Owner** (one per org), **Org Admin** (multiple), **Coordinator** (ground operator, multiple). Verify capabilities in RBAC doc."
- **Response [RBAC] §1:** Owner = org settings + coordinators, full control. Admin (Phase 2) = coordinators, outreach, data; operational control. Coordinator = seeker/provider data in their area, scoped, no admin rights. **Permissions derive from role, not from form-field values.**
- **Eng read:** Roles are clear; the **action-level capability matrix** (onboard, view PII, manage QR/links, edit org profile, billing, manage users) is still not enumerated per role. RBAC doc lists areas, not a gated-action table.
- **Follow-up → product:** provide (or confirm eng-drafted) a role × action matrix — especially **who can view participant PII** and **who can manage other users**.

### 3.3 — Single transferable owner, or co-admins?
- **Status:** 🟡 Partial
- **Response [QD]:** "Single Org Owner with multiple Admins. Can transfer org. Needs more questions answered on details/implementation."
- **Response [RBAC]:** "One Owner per org in Phase 1. **Ownership transfer is out of scope [Phase 1].**" Open Q3/D4: what happens to org + data if Owner deactivated/leaves (Product/Legal, no date).
- **Eng read:** Phase 1 = single owner, **no transfer**. Transfer + owner-offboarding deferred (ties to 10.3). Note [RBAC] D4 still undated.

### 3.4 (new) — Capability difference: aggregator vs voice-bot service?
*Raised by product; was missing from the original doc.*
- **Status:** 🟡 Partial (rich answer, but needs formalizing + a registration path)
- **Response [QD]:** "Aggregator = limited to **item CRUD**, **account CR**; UD on account needs clarification. Voice bot = same as aggregator **plus ability to perform actions**, and **not limited to RUD on items it doesn't own** (aggregators are). But voice bot needs **per-item/action tagging** for audit/metrics (bot-1 created profile, bot-2 applied on their behalf). We currently have **no voice-bot registration** — only a manually-generated network-wide service key shared with the bot."
- **Eng read:** Two distinct service capability profiles:
  - **Aggregator:** item CRUD + account Create/Read (Update/Delete TBD), **scoped to items it owns**.
  - **Voice bot:** item CRU + **action perform** + **may act on items it doesn't own**, with **mandatory actor tagging** per item/action.
  This is **not** in the current Keycloak design (which treated the voice bot as just another scoped client). Needs: per-service scope sets, action-actor tagging on records, and a **voice-bot registration/credential-issuance flow** (see 8.2 / F3).
- **Follow-up → product:** confirm aggregator account **Update/Delete** rights (cross-refs 4.1); confirm the exact voice-bot action scope (any action? on any user?).

---

## 4. Acting on behalf of participants (delegated authority)

### 4.1 — What may an aggregator do on a participant's behalf, and for how long?
- **Status:** 🟡 Partial (CRUD mostly clear; Update/Delete hedged)
- **Response [QD]:** "Aggregator retains **full CRUD on the profile (item) forever**. Reads are **PII-gated** — they can request PII, which **requires a log** (Agg X read User Y's PII at T for reason R). Account **creation** allowed if none exists; **read** allowed at all times. **Updates** are very risky and mostly **blocked** (will confirm). **Delete** possible in certain scenarios."
- **Response [IAM] NRT-4:** CRUD with DPDP consent: Create needs explicit consent + central consent flag; Update beyond original consent scope needs fresh consent; Delete = right-to-erasure, prior notice + confirmation window, propagated via PID deactivation.
- **Eng read:** **Profile (item)** = full CRUD, indefinite. **PII reads = gated + audit-logged** (build a PII-access log: actor, subject, ts, reason). **Account** = Create-if-absent + Read always; **Update/Delete unconfirmed** — blocker for the capability matrix.
- **Follow-up → product:** confirm account **Update** (blocked? which fields?) and **Delete** ("certain scenarios" = which?).

### 4.2 — Is "onboarded-via X" provenance, or standing authority?
- **Status:** ✅ Answered
- **Response [QD]:** "Indefinite authority (as 4.1)."
- **Eng read:** Onboarding = a **standing permission relationship**, not just a tag. The aggregator keeps authority indefinitely.

### 4.3 — When does authority transfer to the participant?
- **Status:** ✅ Answered
- **Response [QD]:** "Aggregator retains control indefinitely. User may report aggregator abuse to the network facilitator (needs further questions). The **gate on the user profile is on until the user logs in and accepts T&C + privacy policy**, which (until then) limits discoverability and actions."
- **Eng read:** No authority hand-off — aggregator authority is permanent. The **participant-login + T&C-accept** event lifts the discoverability/action gate (ties to 7.x and consent). Abuse-reporting path is a separate future flow.

### 4.4 — Can a participant be onboarded by more than one aggregator (1:1 / many / claim-transfer)?
- **Status:** 🔶 Answered + product raised hard sub-questions
- **Response [QD]:** "Aggregator ownership is at the **profile level, not account level**. On Org/Coordinator transfers, the tagged items follow suit. Raises: is there a **max number of profiles per account**? And do aggregators retain CRD on the **account** (per 4.1) — if so, **who gets it when the account's items are owned by multiple aggregators**?"
- **Eng read:** Critical clarification: **ownership is per-profile, not per-account.** An account can hold multiple profiles, each tagged to a possibly-different aggregator. This breaks the simple "owner" model and surfaces a real conflict: **account-level CRD with multiple profile-owners is undefined.** Product flagged both gaps itself.
- **Follow-up → product:** (a) max profiles per account? (b) who holds account-level Create/Read/Delete when profiles are multi-owned — first onboarder? the participant once self-activated (4.3)? NF?

---

## 5. PII visibility & sharing

### 5.1 — Who can see a participant's PII, and when?
- **Status:** 🟡 Partial (per-actor answered; product asked back on revocation + voice bot)
- **Response [QD]:** "1. When a **connect action is accepted by both parties**, the other party can view it — *till when is this maintained, can it be revoked?* 2. Aggregator on item CRUD (per 4.1, PII view is gated + logged — *does that still hold?*). 3. **No answer on voice bot** — does it follow aggregator (logged/requested) or unaudited? 4. **Network admin: cannot.**"
- **Response [IAM] NRT-1 Q3:** Post-accept PII exchange via **field-scoped, time-bound (15–30 min), single-redemption** NF-issued tokens; every issuance/redemption audit-logged. PII flows instance→instance directly, never through NF.
- **Eng read:** Matrix so far: **participant** (own) ✅; **counterparty** after mutual accept ✅ (window/revocation TBD); **aggregator** = gated + logged ✅; **voice bot** = undecided; **network admin** = **never** (good for DPDP). [IAM] gives a concrete token mechanism for the counterparty exchange.
- **Follow-up → product:** (a) post-accept PII view — **persistent or revocable**, and for how long? (b) voice-bot PII = audited-like-aggregator or exempt?

### 5.2 — Which fields are always-private / shared-on-action / public-discoverable?
- **Status:** ✅ Answered (mechanism agreed)
- **Response [QD]:** "Yes — needs configuration on **network.json per instance/network** to define the three levels."
- **Response [IAM] NRT-2 Q1:** the PII/non-PII field classification should be a **central schema definition** (canonical, not per-instance-decided), enforced by instances.
- **Eng read:** Agreement on three tiers driven by network.json. **Tension:** QD says per-instance network.json; [IAM] says **central** canonical schema. Reconcile — likely network.json is authored centrally (source of truth in Signals-DPG examples) and vendored per-instance, which satisfies both.

---

## 6. Cross-instance & multi-instance behaviour
*Product note [QD]: "All three too technical for product; not detailed enough for tech lead to explain." → escalated to the architecture fork note; [IAM] S2/S4 is product-side's answer.*

### 6.1 — Are cross-instance *actions* required (seeker on up-blue ↔ provider on ka-blue)?
- **Status:** 🔴 Open (discovery yes per 1.2; *action* unconfirmed)
- **Eng read:** 1.2 confirms cross-instance **discovery**; cross-instance **action** (connect/apply across instances) is the harder case and is not explicitly confirmed. [IAM] NRT-1 designs for it (central event bus + NF connect tokens) under S2/S4.
- **Follow-up → product:** confirm cross-instance **action** is in scope for the near term, or discovery-only first.

### 6.2 — Permissions/sessions honored network-wide, or re-established per instance?
- **Status:** 🔴 Open → folded into the fork note
- **Eng read:** Centralized-sub ⇒ one session network-wide; federated-NF/PID ⇒ per-instance sessions + NF-issued cross-instance tokens. Decided by the fork.

### 6.3 — Trust relationship between instances of the same network?
- **Status:** 🟡 Partial ([IAM] proposes it)
- **Eng read:** [IAM] S2/S4: instances trust each other via **shared JWKS (S2)** or **domain keypairs + NF (S4)**; cross-instance calls validate NF-issued / realm tokens locally. This finally addresses the *currently-unauthenticated* inter-instance gap. Confirm the topology (shared JWKS vs domain keypairs) in the fork.

---

## 7. Status & lifecycle gating

### 7.1 — What is an *unverified* / *terms-not-agreed* user blocked from?
- **Status:** ✅ Answered
- **Response [QD]:** "Follows a non-logged-in user. Must accept [T&C] to be **discoverable** and **actionable / to make actions**."
- **Eng read:** Pre-consent user = read-only/browse at most; **not discoverable, cannot act, cannot be acted upon** until T&C accepted. Aligns with 4.3 and the consent gating.

### 7.2 — Confirm what each item lifecycle state permits
- **Status:** 🟡 Partial + ↩️ bounced
- **Response [QD]:** "These are fine. **What is the flow from live → draft/paused like, and what happens to related objects like actions?**"
- **Eng read:** State *meanings* confirmed (draft = editable/not discoverable; live = discoverable + actionable; paused = hidden). The **transitions** (live→paused/draft) and **cascade to in-flight actions** are unspecified — engineering to propose.
- **Follow-up → eng:** define live→paused/draft transitions + what happens to pending/accepted actions on a paused/drafted item (cancel? freeze? notify counterparty?).

### 7.3 — Can others discover/act on a non-consented user's item, or only the user's own actions gated?
- **Status:** ✅ Answered
- **Response [QD]:** "User needs to accept T&C to be **discoverable by others**."
- **Eng read:** Important — gating is **bidirectional**, not just the user's own writes. A non-consented user's item is **hidden from discovery and un-actionable**. This extends the consent design (which currently gates only the user's own writes).

---

## 8. External agents (voice bots & other services)

### 8.1 — What may an external agent do, on whose behalf?
- **Status:** 🟡 Partial (terse; see richer 3.4)
- **Response [QD]:** "CRUD on profiles."
- **Eng read:** Thin; 3.4 is the fuller answer (voice bot = item CRU + actions + may act on items it doesn't own + actor-tagging). Reconcile 8.1 with 3.4 — the operative scope is 3.4.
- **Follow-up → product:** confirm "on whose behalf" — only the caller in the session it's handling, or any user? Which fields/actions are off-limits?

### 8.2 — Own narrowly-scoped creds per service, or shared?
- **Status:** 🟡 Partial + ↩️ (product asked the design-gap back)
- **Response [QD]:** "Each gets its own. **Follow-up: how do they get/request/renew? They currently have no access/interface.**"
- **Eng read:** Confirms per-service scoped creds (matches design §7). The **issuance/rotation interface for external services does not exist** — product is asking us to design it. This is F3.

### 8.3 — For a minor, does the guardian get their own account + right to act?
- **Status:** ✅ Answered
- **Response [QD]:** "No. They only **auth via OTP**; they **cannot act on behalf of the minor**. Maybe in future, but lots of legal challenges."
- **Eng read:** Guardian = **contact + OTP-capability only**, not a principal with delegated authority — matches the consent design's "guardian as contact." Good; no IAM principal needed for guardians now.

---

## 9. Account integrity & recovery

### 9.1 — Recovery if a phone-only user loses their phone/email?
- **Status:** 🔴 Open
- **Response [QD]:** "To come back on this."
- **Eng read:** Unblocked elsewhere, but a real gap — phone-only base + no recovery path = lockout risk vs takeover risk. Needs: who may initiate recovery (self / aggregator-assisted / network admin).

### 9.2 — Recycled / reassigned phone numbers?
- **Status:** 🔴 Open
- **Response [QD]:** "To come back on this."
- **Eng read:** Significant for phone-as-identity (esp. voice). Needs a re-verification / disassociation policy.

### 9.3 — Prevent duplicate accounts, or allow (e.g. separate seeker/provider)?
- **Status:** ✅ Answered (and pins the identity model)
- **Response [QD]:** "One person can hold **multiple profiles (items)** under **one account**. Multiple accounts on the same identity (phone/email) is allowed **by each instance on the network**. **Not allowed on the same instance.**"
- **Eng read:** The precise rule: **uniqueness is per-(identity, instance)** — one account per phone/email *per instance*, many accounts across instances, many profiles per account. Confirms 1.1/1.4 and the per-instance model; rejects "one human = one sub" globally.

---

## 10. Administration, audit & offboarding

### 10.1 — What can the network admin do / be barred from?
- **Status:** 🔶 Answered-but-conflicts-with-[RBAC]
- **Response [QD]:** "They can **only approve/reject Aggregator Owner registrations**. They also **receive emails** on support/complaints raised at any level."
- **Eng read:** Very narrow (good for DPDP — explicitly **no PII access**, cf. 5.1). **Conflict:** [RBAC] §3 says the **Network Admin manages configurable forms/schema templates centrally**. So the admin either (a) approves orgs + owns form/schema config, or (b) only approves orgs. Reconcile.
- **Follow-up → product:** does the network admin own form/schema templates ([RBAC]) or not (QD 10.1)? If yes, that's a second, broader admin capability than stated here.

### 10.2 — Whose identity is recorded as actor when a service acts on a user's behalf?
- **Status:** ✅ Answered
- **Response [QD]:** "Service/Aggregator tagging must be on **account CUD, profile CUD, and actions CUD**."
- **Eng read:** Confirms the truthful-actor model: record **performed_by (service) + on_behalf_of (participant) + acting_org** on every account/profile/action mutation. Matches design §7's attribution triple — and extends it to **account-level** ops. Reinforces the voice-bot per-action tagging from 3.4.

### 10.3 — When an org user / aggregator is offboarded, what happens to their participants/items?
- **Status:** ✅ Answered
- **Response [QD]:** "Transferred to the **Org Owner**, who can reassign to a coordinator under them."
- **Eng read:** Offboarding = **reassign up to Org Owner → down to another coordinator**; not orphaned, not deleted. Ties to 4.4 (profile-level ownership transfer) and 3.3 (owner offboarding still open).

### 10.4 — Rotation / expiry / revocation policy for service creds?
- **Status:** 🟡 Partial
- **Response [QD]:** "Follow standards."
- **Eng read:** Defer to engineering best-practice (short-lived tokens + rotation, per-service revocation — design §7). Treat as eng-owned; no product blocker.

---

## New engineering follow-up questions (gaps not previously asked)

- **F1 — The identity fork (blocking).** Centralized Keycloak `sub` vs federated NF/PID. Everything downstream (consent keying, cross-instance, the whole migration) depends on it. → see fork note.
- **F2 — Profile-vs-account ownership (from 4.4).** If an account holds N profiles owned by *different* aggregators, who holds account-level CRD (4.1)? Is there a **max profiles per account**?
- **F3 — Service registration/credential interface (from 8.2 / 3.4).** Voice bots/aggregators need a way to **request / receive / rotate** scoped creds — no interface exists today. Design it (self-serve request → network-admin approve → client-credentials issue → rotation/revocation).
- **F4 — Network-admin scope conflict (10.1 vs [RBAC]).** Approves-orgs-only, or also owns form/schema templates? Resolve before the role matrix.
- **F5 — Both-roles on one account (2.1/2.3 vs 9.3).** Is "seeker + provider" one dual-role profile or two profiles? How does matching avoid **self-matching** a person who is both?
- **F6 — Post-accept PII window (5.1).** Is the counterparty's PII view **persistent or revocable**, and for how long? ([IAM] proposes 15–30 min single-use tokens — confirm that's the intended lifetime vs an ongoing relationship view.)
- **F7 — Consent at initiate, not just accept ([#99] statement 4).** The consent issue wants a consent gate **when connect/apply is initiated**; our consent design currently captures consent **at accept only**. Confirm we add the initiate-time gate (forces a consent-design change).
- **F8 — Lifecycle transitions (7.2).** Define live→paused/draft transitions and the cascade to in-flight actions.

---

## How answers feed the design

- **§1, §6, §9 → identity model & integrity.** Now **per-instance accounts + network-wide discovery via an NF/PID layer** (P1/P4 rejected). The centralized-vs-federated **fork** (F1) gates the Keycloak and consent specs.
- **§2, §3 → role & permission catalogue.** Owner/Admin/Coordinator confirmed ([RBAC]); multi-role participants/coordinators (instance-gated). Still need the **role × action matrix** (3.2/F4) and the **aggregator-vs-voice-bot capability split** (3.4).
- **§4, §5, §7, §8, §10 → access rules.** Profile-level ownership + indefinite aggregator authority (4.x); PII gated + audit-logged, network-admin never (5.1); bidirectional consent gating (7.3); per-service scoped creds + missing issuance interface (8.2/F3); truthful actor tagging on account/profile/action (10.2); offboard-to-owner reassignment (10.3).

**Open blockers before design finalize:** F1 (identity fork), F4 (admin scope), F2 (account-vs-profile ownership), 5.1 PII window, 9.1/9.2 recovery. Where product is undecided, state **design-for-flexibility** (costlier now) vs **lock-the-simple-rule** (cheaper, harder to undo) — that choice is itself useful.
