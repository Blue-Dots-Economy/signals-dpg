# Account vs Profile — Questions for Product

**Date:** 2026-08-30 · **For:** Product / Business · **From:** Engineering
**Scope:** Signals-DPG + aggregator-dpg + the voice channel.
**Companion:** `2026-08-30-account-profile-identity-model-design.md` (the technical model)
**Continues:** `2026-07-22-iam-pending-decisions-for-product.md` — D1–D8 there are still
open and still needed. This document does **not** restate them; it adds D9–D14, which
came out of a fresh review of how accounts and profiles are actually built and used.

## Why this document

We looked again at the split between an **account** (the thing you log in with) and a
**profile** (the dot on the map). There has never been a stated rule for which details
belong to which, and that gap is now causing real problems in production — not
hypothetical ones. Most are fixable by engineering without your input, and we are
proposing to fix them. A smaller set are **rules only product can set**, and those are
below.

Status key is the same as the July document: 🔴 blocks build · 🟡 needed soon ·
🔵 can wait · 🟢 settled.

---

## First: four things you should know are happening today

These are findings, not questions. We are not asking you to decide them — we are
telling you, because two of them affect people's data right now.

**F1 — Two companies' job postings can end up owned by one login.** When an aggregator
uploads job postings, our system currently *guesses* which column is the account's phone
number, by looking for a column whose name contains "phone". For the jobs schema, that
guess lands on the **hiring manager's** number. So a hiring manager who consults for two
different companies causes both companies' postings to be merged under a single account —
and whoever holds that phone can see and manage both. No hacking required; ordinary use
produces it.

**F2 — The same guess splits one company into many accounts.** Two postings from one
company with two different hiring managers become two separate accounts, both carrying
the company's name.

**F3 — Aggregators can see and decrypt each other's work.** We tag the *person* with the
aggregator who first onboarded them, not the *profile*. So if aggregator B adds a profile
for someone aggregator A onboarded earlier: B cannot see or export the profile B just
created, while A can see it, export it, and decrypt its personal details. Dashboards and
campaign counts credit B's work to A. Note this contradicts something the July document
already recorded as settled — *"ownership is per-listing, not per-account"*. The rule was
agreed; the system does not implement it.

**F4 — Personal details in the accounts table are stored unencrypted.** Names, phone
numbers, emails and ages sit in plain text, readable by anyone with database access, even
though we describe the platform as DPDP-compliant. Profile data is already encrypted;
the accounts table was never brought across. We are fixing this regardless of the answers
below.

Engineering is proposing to fix all four. F1–F3 share one root cause: the platform
invents an account out of profile data whenever nobody supplied one.

---

## The pending decisions

### 🔴 D9 — Can an account be a **company**, or is it always a person?

**Plain question:** In the jobs domain, the thing that registers is often a company, and
the people who act for it (hiring managers) are different people, sometimes several, and
sometimes contractors who work for more than one company. Today we have exactly one kind
of account and it is implicitly a person. Should a company be its own account, with named
humans acting on its behalf — or is a company always represented by *the individual who
registered it*?

**Why it matters:** This is the root of F1 and F2 and it is the biggest single fork in the
model. It also decides ordinary operational questions you will be asked: *what happens to
a company's job postings when the person who registered leaves?* Today: nothing good.

**Recommended default (design for flexibility):** Make it explicit that an account is
either **a person** or **an organisation**, and that a profile is *held by* one of them
while *being about* someone (possibly nobody). We can ship the person-only behaviour
first and add organisations later without a rewrite — but only if you tell us now that
organisations are eventually real, because it changes the shape we build.

---

### 🔴 D10 — Can a profile exist with **no account at all**?

**Plain question:** In tourism (orange_dot), aggregators onboard practitioners who never
log in, never apply to anything, and may not even have a phone number recorded. Today the
system *forces* us to create a login account for each of them anyway, because a profile
must have an owner. Should we allow a profile to be owned by the **aggregator
organisation**, with no person attached until someone actually verifies and claims it?

**Why it matters:** This is the direct cause of the fake accounts in our database, and it
is what makes our "number of accounts" metric untrustworthy. It also matters legally: we
are currently creating identity records for people who never asked for one.

**Recommended default (lock the simple rule):** **Yes.** A profile is owned by whoever
created it (a person or an organisation), and separately *may* have a verified person
attached. Onboarding an unclaimed profile stops creating a phantom account; the person
becomes real when they verify. This also gives you a genuinely useful campaign metric —
how many real, verified people a campaign produced, rather than how many rows an importer
made.

---

### 🔴 D11 — A phone number on a profile that isn't the account's — what may its holder do?

**Plain question:** Job postings carry a hiring manager's number. Seekers sometimes give a
different number on their profile than the one they registered with. The voice bot now
calls those numbers. When that person answers, what are they allowed to do — just listen
and be told things, update *that one profile*, or act as the account?

**Why it matters:** This is the live blocker for voice campaigns. Right now the bot calls
the profile's number, then cannot recognise it, and can end up creating a **duplicate
account** for someone who already exists. See also **D7** in the July document, which
asked the narrower version of this question and is still open.

**Recommended default (lock the simple rule):** The person who answers can be *told*
things and can update **the specific profile their number is on** — never the account,
never that account's other profiles. Rationale: by typing that number into that posting,
the account holder designated that person for that posting, and nothing more. We would
also treat calls **we placed** as trusted (they answered a number we chose) and calls
**they place to us** as untrusted until verified, since caller ID can be faked.

---

### 🟡 D12 — Do we have to tell the hiring manager we hold their number?

**Plain question:** The jobs schema makes the hiring manager's phone number and name
**required**. That is a third person's personal data, collected from the employer, and
that person is never told we hold it, never sees terms, and never consents. If we now
start *calling* them, this becomes considerably more visible.

**Why it matters:** Under DPDP this is a real obligation, and it exists today
independently of anything we build. It is also the cheapest to fix: a line of notice text
on the form the employer fills in, plus a message at the start of the call.

**Recommended default:** Add notice at the point the employer enters the number, and an
opt-out at the start of any call. Please confirm the wording route with legal.

---

### 🟡 D13 — Limits: how many profiles, and is one-type-per-person staying?

**Plain question:** Two separate limits, and we have neither properly today.
(a) How many profiles may **one person** hold, per domain? (There is no limit configured
now.) (b) How many profiles may **one aggregator** hold — a commercial quota, not a
safety one? And separately: today a person can be a seeker *or* a provider, never both.
Is that a rule we keep, or a temporary restriction?

**Why it matters:** You have asked for multiple profiles per person with different
contact details, which we are supporting. Without a cap, "multiple" is unbounded, and
bulk upload can inflate it invisibly. The seeker/provider restriction is currently
written into how accounts are stored; we would rather it were a setting.

**Recommended default (design for flexibility):** Build both limits as **settings** with
no limit by default, so you can set numbers later without engineering work. Make the
seeker/provider restriction a per-network setting too — that is what lets us open the
network up later without a rebuild. See also **D4** in the July document.

---

### 🔵 D14 — When someone asks to be deleted, what happens to profiles an aggregator owns?

**Plain question:** If a profile was created and is owned by an aggregator, and the person
it describes asks us to erase their data — does the profile disappear, or does it survive
without them attached, because the aggregator has its own reason to hold it?

**Why it matters:** It changes what "delete my data" means, and it is a legal call rather
than an engineering one. It only becomes live once D10 is answered yes.

**Recommended default:** None — we would rather you and legal decide this one. Engineering
can implement either.

---

## What engineering is deciding (FYI — no product action)

For completeness, these came out of the same review and are ours to settle:

- Replacing the guessed account-identity mapping with one the network admin declares
  explicitly (fixes F1, F2).
- Moving the aggregator tag from the person to the profile (fixes F3).
- Encrypting the accounts table and moving the encryption key into managed key storage
  (fixes F4).
- Making every decryption a scoped, purpose-stated, audited request rather than a general
  capability.
- Storing multi-location postings as one row per location, so all locations appear
  correctly on the map and in "nearest" searches.
- Recording campaign attribution on each profile so campaign counts are correct
  regardless of who onboarded the person first (supports D13 and the campaign metric in
  D10).

---

## Priority

| Order | Decision | Why first |
|---|---|---|
| 1 | **D11** | Blocks the voice campaign work already in flight |
| 2 | **D10** | Blocks the fix for phantom accounts and the campaign metric |
| 3 | **D9** | Biggest fork; changes the shape we build even if deferred |
| 4 | **D12** | Live compliance obligation, cheap to fix |
| 5 | **D13** | Needed before limits ship, not before they are built |
| 6 | **D14** | Only live once D10 is yes |

D1, D4, D6 and D7 from the July document remain open and are still needed; D1 and D7 in
particular overlap directly with D9 and D11 here and could be answered in the same
session.
