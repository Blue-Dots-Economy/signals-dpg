# IAM & Network Design — Pending Decisions for Product

**Date:** 2026-07-22 · **For:** Product Manager · **From:** Engineering (auth/IAM design)
**Scope:** Signals-DPG + aggregator-dpg (+ the voice/campaign channels that act on participants).

## Why this document

We now have a settled *architecture* for identity and access across the network (see "What's
already settled" below). Before engineering can start building the auth rework, a smaller set of
**policy choices that are product's to make** need answers. This doc lists each one in plain
language, says **why it matters**, and gives **engineering's recommended default** so you can either
accept it or steer us. Nothing here is technical — it's about *rules and rights*, not code.

For each decision we flag the choice as:

> **Lock the simple rule** — cheaper to build now, harder to change later. Good when we're confident.
> **Design for flexibility** — costs more now, easy to change later. Good when product is undecided.

Telling us *which stance* you want is itself a useful answer, even if you can't pick the specifics yet.

---

## How to read the status

| | Meaning |
|---|---|
| 🟢 | **Settled** — decided, engineering can build on it |
| 🔴 | **Open — blocks build** — we can't write the access rules without this |
| 🟡 | **Open — needed soon** — not blocking day one, but needed within the first phases |
| 🔵 | **Open — can wait** — a real gap, but safely later |

---

## What's already settled 🟢 (no action needed — for context)

The single biggest question — *"is a person one identity across the whole network, or one per
operator?"* — is **decided**, and it unblocks everything else:

- **Each operator (instance) keeps its own accounts.** The same phone can register on two
  instances; they're two separate accounts. Operators keep sovereignty over their own participants'
  data. *(There is no network-wide "one login everywhere" — and we confirmed we don't need one.)*
- **The network still behaves as one for discovery** — a registry ties instances together so people
  and listings are findable network-wide, without pooling personal data centrally.
- **An "Aggregator" is an organisation-level operating unit, not a person.** Many coordinators
  (people) can operate under one aggregator. This is the model in the RBAC doc, now baked in.
- **Ownership is per-listing, not per-account** — a participant's different listings can be managed
  by different aggregators.

Everything below is the *finer policy* that sits on top of this.

---

## The pending decisions

### 🔴 D1 — Who controls the *account* when its listings belong to different aggregators?

**Plain question:** A participant can have several listings, each managed by a different aggregator.
So who is allowed to do account-level things — read the whole account, deactivate it, delete it?
And **is there a maximum number of listings per account?** Separately: once an aggregator has
onboarded someone, can it **edit or delete** that person's *account* (not just their listing), or
only create-if-missing and read?

**Why it matters:** This is the #1 blocker. We literally cannot write the "who's allowed to do what"
rules until account-vs-listing authority is pinned. You already flagged this gap yourself (Q4.4).

**Recommended default (lock the simple rule):** The **participant owns the account**; aggregators
get **full control of the listings they onboarded, forever**, but on the *account* only
**create-if-missing + read** — **no account edit/delete** by an aggregator. Cap listings per account
at a generous number (e.g. 10) we can raise later.
*Flexibility alternative:* make account-edit rights a per-instance config flag — more build, defer the call.

---

### 🔴 D2 — What can the Network Admin do — approve organisations only, or also own the templates?

**Plain question:** Two of your docs disagree. One says the Network Admin **only** approves/rejects
aggregator-org registrations (and gets complaint emails). The other says the Network Admin also
**publishes the listing templates and consent copy** (the `network.json` rules). Which is it?

**Why it matters:** It defines an entire role's powers and, crucially, **who authors the rules of the
network**. It also affects our data-privacy story (a narrow admin that *cannot* see personal data is
better for compliance).

**Recommended default (lock the simple rule):** Network Admin = **approve orgs + own the templates/
consent copy + receive complaints**, and **never sees participant personal data**. (This reconciles
both docs: broad over *configuration*, zero over *personal data*.)

---

### 🔴 D3 — Spell out the role × permission table (especially: who sees personal data, who manages users)

**Plain question:** We have the roles (Org Owner, Org Admin, Coordinator, and future Aggregator
members). We do **not** have the table of *which role can do which action* — most importantly **who
can view a participant's personal information (PII)** and **who can add/remove other users**.

**Why it matters:** The access system is built directly from this table. Missing cells = we either
guess or stall.

**Recommended default:** Engineering drafts the full table from the RBAC doc and sends it back for a
yes/no per row. Baseline: **only Coordinators (and the participant) can request PII, always
audit-logged; Owners/Admins manage users; Network Admin sees no PII.**

---

### 🟡 D4 — "Seeker + provider on one account": one dual listing, or two? And how do we avoid self-matching?

**Plain question:** You confirmed a person can be **both** seeker and provider on the same account.
Is that **one listing that plays both sides**, or **two separate listings**? And when someone is
both, how should the network avoid **showing them to themselves** as a match?

**Why it matters:** Shapes the listing model and the matching logic. Not day-one blocking, but needed
before we build discovery/matching.

**Recommended default:** **Two separate listings** (one seeker, one provider) under one account;
matching excludes listings owned by the same account. Simplest to reason about and to keep private.

---

### 🟡 D5 — Do people on *different* operators connect/apply to each other yet — or is cross-operator only "discovery" for now?

**Plain question:** We've confirmed people can **discover** counterparts on other operators'
deployments. Can they also **connect/apply across operators** in the near term, or is step one
**discovery-only**, with cross-operator connect coming later?

**Why it matters:** Cross-operator *connecting* (with a consented exchange of contact details between
two operators) is materially more work than cross-operator *discovery*. Knowing the near-term scope
lets us right-size the trust/security phase.

**Recommended default (lock the simple rule):** **Discovery-first.** Ship cross-operator discovery
now; treat cross-operator connect/apply as a fast-follow. (If it's needed at launch, tell us — it
changes the plan.)

---

### 🟡 D6 — After two people connect, how long can each see the other's contact details — forever, or a window?

**Plain question:** Once a connect/apply is mutually accepted and contact details are exchanged, is
that view **permanent**, or **time-limited / revocable**? (You asked this back at us.) Same question
for the **voice bot**: does its access to personal data follow the same "gated + logged" rule as an
aggregator, or is it exempt?

**Why it matters:** It's a core consent/privacy promise to participants, and it drives how we hand
out access to personal data.

**Recommended default:** Contact-detail exchange is **persistent for the life of the connection**
(people need to keep talking), but **revocable if either party withdraws consent**. Voice bot =
**same gated + audit-logged rule as an aggregator**, never exempt.

---

### 🟡 D7 — Is a phone number enough to prove identity when a bot acts "on behalf of" someone?

**Plain question:** The voice assistant (and other assisted channels) act *on behalf of* a real
person, identified by their **phone number**. Is a verified phone number **enough proof** for the
bot to read that person's listings and perform actions for them? And exactly which actions can the
bot do, on whose behalf?

**Why it matters:** This is the trust boundary for every assisted/voice interaction. Set it too loose
and someone could act as another person; too tight and assisted users can't be helped.

**Recommended default:** Phone-verified (OTP-confirmed) is **sufficient for that caller's own
listings and actions in that session**; the bot may **not** act for arbitrary other users; every
bot action is **tagged and logged** (which bot did what, for whom).

---

### 🔵 D8 — Account recovery if someone loses their phone; and recycled phone numbers

**Plain question:** People sign in mostly by phone. What happens when someone **loses their phone/
number**, or a telecom **reassigns a number** to a new person? Who's allowed to recover an account —
the person, an aggregator on their behalf, or a network admin?

**Why it matters:** Phone-only sign-in with no recovery path risks locking people out (or, worse,
letting a new holder of a recycled number take over an old account). It's not day-one blocking but
it's a real safety gap.

**Recommended default:** Ship with **aggregator-assisted recovery + OTP re-verification**; add
self-serve recovery later. Flag recycled numbers by forcing re-verification on any dormant account.

---

## The five things engineering will decide (FYI — no product action)

For completeness, these are ours to settle and don't need your input, but they're on the critical
path so you know they're tracked: (1) how the access-rules engine is deployed; (2) a proper way for
aggregators/bots to **request and rotate their credentials** (none exists today — it's a shared key);
(3) how we migrate existing logins onto the new system without downtime; (4) what happens to
in-flight connections when a listing is paused; (5) checking consent at the *moment someone initiates*
a connect, not only when it's accepted.

---

## Priority & suggested meeting agenda

**Must answer before build starts:** **D1, D2, D3** (these define the access rules).
**Answer within the first phases:** D4, D5, D6, D7.
**Can follow:** D8.

Suggested 45-minute review:
1. Confirm the settled model (5 min) — sanity-check nothing has changed.
2. **D1 account-vs-listing authority** (10 min) — the big one.
3. **D2 + D3 admin scope & the role table** (10 min).
4. D5 cross-operator scope + D4 dual-role (10 min).
5. D6 PII window + D7 voice trust (10 min) — can run to a follow-up if time-boxed.

Where you're undecided, just tell us **"lock the simple rule"** or **"design for flexibility"** for
that item — that alone unblocks us.
