# Consent Management — Functional Design (for Product)

**Date:** 2026-06-25 · **Audience:** Product
**Source of truth:** [`2026-06-25-consent-management-design.md`](./2026-06-25-consent-management-design.md) (full design)
**Status:** Design — pending review

> This is the *functional* view: what the system does, who it serves, and the journeys it must support. For data models, APIs, and deployment see the companion **Technical Architecture** doc.

## 1. The problem today

Consent is captured inconsistently and is not trustworthy or auditable:

- **Signals self-signup** captures *no* real consent — it's an implicit footer line, and the account is silently marked "accepted."
- **Aggregator-onboarded users** (bulk/QR/voice) are marked "consented" using a config default — the user may never have agreed.
- The **voice/QR form** collects consent checkboxes that are **thrown away**.
- **Per-action consent** (when connecting/applying shares personal data) is shown but **not stored** — there's no record of who agreed to share what.
- Nothing is **versioned** — if we change the privacy policy, we can't tell who agreed to which version, and we can't re-ask.
- There is **no withdrawal, no expiry, no data-deletion** path.

This is both a **trust gap** (we claim consent we can't prove) and a **compliance gap** (India's DPDP Act requires provable, specific, withdrawable consent and parental consent for minors).

## 2. What we're building

A single **consent system shared across Signals and the Aggregator**, covering every channel a user can reach us through. It gives us:

- **Versioned consent documents** — Privacy Policy, Terms, Operator Terms, and per-action statements. Publishing a new version automatically **re-asks** affected users.
- **A tamper-evident consent ledger** — an append-only record of every acceptance/withdrawal: *who agreed, to what version, what data, for what purpose, for how long, on which channel, and whether it was verified*. Each entry is a standards-aligned **consent receipt**.
- **Capture on every channel** — UI, voice bot, aggregator-assisted, and bulk — each handled appropriately.
- **Minor / guardian consent** for under-18 users.
- **Withdrawal and full data erasure**, including telling the onboarding aggregator to delete its offline copies.

## 3. Who consents, and to what

| Principal | Consents to |
|---|---|
| **Participant** (end user) | Privacy Policy, Terms of Service, and **per-action** statements (e.g. "sharing your phone number when you connect") |
| **Operator** (aggregator org admin) | Operator Terms at organisation registration |

Each network (e.g. blue_dot) has its **own** document set. A network may require only privacy, only terms, or both — whatever is published and active is what's required. **Active = required.**

## 4. The journeys

### 4.1 Signals UI — new self-signup
User enters details **including date of birth**, sees the active Privacy/Terms in a popup, ticks one required agreement box, completes signup → consent recorded. If under 18, the guardian step (4.6) runs first.

### 4.2 Signals UI — returning user
On login we check consent. If a document changed, expired, or was withdrawn, a **blocking "what's new" modal** appears and they must re-agree before continuing.

### 4.3 Voice bot
The bot reads the statement and captures **verbal agreement**. To keep paid calls short, verification is **configurable**:
- **Default:** record the verbal agreement immediately, then send an OTP/confirmation link to the registered phone/email for the user to confirm **after** the call (no minutes wasted waiting).
- **Optional:** confirm via OTP during the call.
- **Fallback:** verbal agreement only, where no OTP provider exists.

### 4.4 Aggregator QR / link form (user fills it themselves)
The user fills the form and agrees. Recorded as agreed but **"unverified"** until an OTP confirmation step exists for that instance.

### 4.5 Aggregator QR / link form (someone fills it for them — proxy)
The form asks "are you filling this for yourself or someone else?" A **proxy** agreement is recorded as *proxy-asserted* and **must be re-confirmed by the real user** on their next direct turn (UI/voice). The helper's relationship is recorded.

### 4.6 Bulk CSV upload
The participant isn't present and gave no agreement, so **we record no consent** (recording one would be fabricating it). The user is simply asked the **next time they show up** on UI or voice.

### 4.7 Performing an action (connect / apply)
When an action will share personal data, the user sees and agrees to the relevant **action statement** before it proceeds; the agreement is stored against that specific action.

### 4.8 Minors (under 18)
We capture date of birth. If under 18, we collect a **guardian's** details and consent. Where the instance can send OTPs, the guardian is verified by OTP; otherwise it's recorded as unverified. **When a document version changes, the guardian re-consents** (they are the legal decision-maker).

## 5. Versioning & re-consent

Publishing a new version of any document **automatically invalidates** the old agreement and re-asks the user **at their next appropriate turn** — UI login or voice call. The re-consent screen shows a **"what's new"** summary. Consent can also **expire** on a configurable validity period (separate from how long we keep the data).

## 6. Withdrawal & data deletion

- **Withdraw** — the user can withdraw; we immediately stop processing and hide their items/actions, and re-ask if they return.
- **Erase** — a full deletion that removes their data from Signals, the Aggregator, and the search index, **and emails the onboarding aggregator to delete any offline copies** (which must be acknowledged for the record). Legally required records are retained. **The consent ledger itself is never deleted** — it's our proof the request happened.

## 7. Verified vs unverified — what it means for product

Many instances won't have an SMS provider configured. The system **degrades gracefully**: where OTP can be sent, consent is **verified**; where it can't, it's recorded as **unverified** (still valid, but flagged). The moment an instance configures a provider, verification turns on automatically — no rebuild. Product should expect a mix and decide where "unverified" is acceptable per use case.

## 8. Compliance value

Directly satisfies **India's DPDP Act** (clear affirmative consent, itemised notice of what/why/how-long, easy withdrawal, erasure, **verifiable parental consent for minors**, multilingual notices) and aligns with **ISO 29184 / Kantara consent receipts**, **W3C DPV**, and **DEPA** consent-artefact interoperability — positioning us toward a recognised "Consent Manager" posture.

## 9. Rollout (phased)

1. Core consent service (documents + ledger + capture/withdraw)
2. Signals UI signup/login consent + public Privacy/Terms pages
3. Per-action consent
4. Aggregator operator terms + QR/voice/bulk capture
5. Minors / guardian
6. Withdrawal stop-processing + full erasure

## 10. Open product decisions

1. **Bulk** users: confirm we record "no consent yet" (recommended) rather than a placeholder.
2. **Legal-hold list** — which records must be retained on erasure (needs legal input).
3. **"Unverified" acceptance** — where in the product is OTP-verified consent mandatory vs optional?
4. **Voice caller identity** — how confident must we be that the caller is the registered person before counting their consent?

**Dependency:** the whole system keys on a single shared identity — it requires both DPGs to move onto **Keycloak** as the common login. That convergence is a prerequisite.
