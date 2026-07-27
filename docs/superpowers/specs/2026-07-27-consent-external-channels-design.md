# External-channel consent — nudges, channel provenance & U18 redirect

**Issue:** [#367](https://github.com/Blue-Dots-Economy/signals-dpg/issues/367) — Handling Terms & Consent for channels outside the app
**Epic:** [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99)
**Date:** 2026-07-27
**Status:** Design — pending review.

**Builds on (does not restate):**
- `2026-07-22-participant-compliance-consent-design.md` — the `compliance` array on `/admin/participant`.
- `2026-07-24-participant-consent-activation-readstatus-design.md` — accept-only validation (`CONSENT_DECLINED`), the both-or-none user pair (`USER_LEVEL_INCOMPLETE`), the gated-domain age requirement (`DOB_REQUIRED`), activation of a draft by targeting `item_id`, and the read-status endpoint.
- `2026-07-27-consent-version-upgrades-design.md` — `event` column, `consentStatus`, and the advance-notice window that determines *when* a re-consent nudge is warranted.

**Depends on:** #331 / PR #359 — `user.age` is an age **snapshot**, not a birthdate. `isMinor(age) = age <= 18`, adult at 19+.

---

## 1. What #367 actually still needs

#367 tabulates four flows (T&C, profile create, profile update, connect/apply) × two audiences (adult, minor), and for each: a state change plus **"Trigger Email (if available) / SMS (if linked) / WA (if linked)"**.

The state-change half is largely already designed and landed. The 07-22/07-24 specs establish that missing consent yields a created-but-`draft` profile, that a minor on a gated domain stays `draft` "to be completed via the portal", and that partial consent is a `400`. Mapping #367's table onto what exists:

| #367 scenario | Status |
|---|---|
| 1.1 / 1.2 — T&C missing or partial → non-live | ✅ Covered. Missing → `draft`; partial → `USER_LEVEL_INCOMPLETE`. |
| 1.3 — minor → non-live + guardian OTP | ⚠️ Partly. Minor → `draft` is covered. "Complete guardian OTP" must **not** happen on an external channel — see §3. |
| 2.1 / 2.2 — profile consent missing/partial → non-live | ✅ Covered by the go-live gate. |
| 2.3 — minor profile consent | ⚠️ Same as 1.3. |
| 3.1–3.3 — **consent to update a profile** → block update | ❌ **No update-time consent gate exists.** New hook point → registry spec. |
| 4.1–4.3 — connect/apply consent | ⚠️ Gate exists for UI; not reachable from external channels. §4. |
| **All rows — the Email/SMS/WA nudge** | ❌ **Entirely absent.** No nudge or reminder mechanism exists in either repo. §2. |

So this spec delivers three things: **the nudge system** (the large missing half), **channel provenance**, and **the U18 external-channel contract**. It hands the profile-update consent point to the registry spec, because that is a new gate hook rather than channel plumbing.

## 2. Nudges

### 2.1 Trigger model

A nudge is warranted when a participant is in a state only *they* can resolve, and they are not currently in the app. Two triggers:

1. **`consent_pending`** — an external channel created or updated a user/profile and consent is absent, so the profile cannot go live. Fired from the `/admin/participant` write path after the transaction commits.
2. **`consent_regate`** — the advance-notice window opened, or a version came into force unaccepted. Fired from a sweep over `consentStatus` (the same sweep that performs grace-window demotion in the versioning spec).

Both resolve to the same send path, with different templates.

### 2.2 Channel selection — capability-gated

Reuse the pattern already proven by guardian OTP (`services/guardian_otp.ts`, `guardian_action_gate.ts`): every send checks whether a provider is configured, and degrades rather than failing.

Preference order, first available wins: **email → SMS → WhatsApp**. Availability means *both* the participant has that contact on file *and* the instance has a provider configured for it. If none is available, record the skip and move on — a nudge is best-effort and must never fail the originating write.

> Order rationale: email is cheapest and adopters most often lack SMS (per §7 of the cross-DPG design). Networks that prefer SMS-first can override via config.

Templates resolve per network from notification config, exactly as the guardian OTP templates do (`scenario: { kind: 'consent_nudge', trigger }`), so no template ids are hardcoded.

### 2.3 Idempotency and rate limiting

This is the part that matters — a version bump across a live network is a bulk-send event and a trivially self-inflicted SMS-bombing vector.

- **Dedupe key:** `(user_id, network, trigger, point, document_version)`. A given user is nudged **once** per point per document version. A second version bump produces a new key and therefore a new nudge; re-running the sweep does not.
- Persist the dedupe key in Redis with a long TTL **and** append a `provenance` ledger row (`event='provenance'`, `metadata.nudge`) so the record survives a Redis flush. The ledger is the durable record; Redis is the fast path.
- **Cooldown:** no more than one consent nudge per user per 24h across all points, so a user missing three consents receives one message, not three.
- Existing notification-service rate limits still apply on top.

### 2.4 Content

The nudge names the action and links to the app — "complete your registration", "your profile isn't visible yet", or for a re-gate, the `change_summary` and the in-force date. It never contains the consent text itself: **consent is captured in the app, never by replying to a message.** A link is a prompt, not a capture surface.

## 3. U18 on external channels — explicit redirect

**Principle:** no minor can establish consent on an external channel. Guardian consent requires the OTP flow, which requires the participant to be in the Signals UI. Voice already cannot serve minors; the same rule applies to every external channel.

Today a minor on a gated domain yields a `draft` profile and the caller must infer why from `lifecycle_status`. Make it explicit so callers can branch:

The `/admin/participant` response gains, alongside the existing `lifecycle_status` and `consent_recorded`:

```jsonc
{
  "consent_outcome": {
    "state": "recorded" | "pending" | "u18_redirect_required",
    "pending_points": ["user_terms", "user_privacy", "profile_creation"],
    "reason": "minor_requires_guardian_flow"   // when u18_redirect_required
  }
}
```

`u18_redirect_required` is returned when the resolved age indicates a minor on a guardian-gated domain. Behaviour:

- The account and profile **are** created, in `draft`. Creation never requires consent (07-24).
- **No** consent rows are written — not even user-level terms. A minor's platform consent is the guardian's to give.
- **No** guardian OTP is initiated. External channels do not start the guardian flow.
- The caller ends its flow and directs the participant to the Signals UI.
- The `consent_pending` nudge fires with the U18 template ("ask a parent or guardian to help you finish in the app").

This is a **response addition, not a status-code change** — the call still succeeds. Per `project_crossrepo_cutover_pattern.md`, consumers (voice-dpg, aggregator) must tolerate the new field before it is relied upon; it is additive so existing callers are unaffected.

## 4. Action consent from external channels (#367 §4)

Connect/apply consent is currently reachable only from the UI: `perform_action` / `update_action_status` gate on `body.consent.acknowledged` when the interaction declares `reveals_pii_on_status`.

For an external channel the participant *is* present (a live voice call), so the acknowledgement is legitimate. Two changes:

1. **`compliance` accepts action keys.** The 07-22 design says unknown keys are ignored, explicitly reserving "a future action/connect key". Recognise `action:<type>:<stage>` (e.g. `action:apply:initiate`) on the participant path, recorded with the same server-resolved version as the UI path. Unknown keys stay ignored.
2. **Minors are refused.** An action key from an external channel for a minor on a gated domain → `u18_redirect_required`, no row written, no OTP sent. Guardian action consent stays UI-only.

Per-application freshness is already correct and unchanged: action rows key on `action_id` and are never reused, which satisfies #364 adult #2 / minor #2.

## 5. `channel` becomes a first-class column

`consent_record` has no `channel` column. The channel is stashed in free-form `metadata.channel` by exactly one caller (`/admin/participant`), so the ledger cannot answer "which surface captured this consent?" — a question both DPDP audit and #367's own per-channel table require.

| column | type | notes |
|---|---|---|
| `channel` | `text NOT NULL DEFAULT 'ui'` | `ui` \| `voice` \| `link` \| `bulk` \| `self` |

Mirrors the existing `channel` enum on `UpsertParticipantRequest`. Backfill: copy `metadata.channel` where present, default `ui` otherwise (the UI is the only other writer today). Every write site passes it explicitly; `metadata.channel` is retired.

## 6. Testing

**Pure/unit** — nudge channel selection across the capability matrix (contact present × provider configured, all combinations, including none-available); dedupe key construction; 24h cooldown; U18 detection at the `age <= 18` boundary with a null age (fail-closed, never treated as adult).

**API/integration** — external-channel create with no consent → `draft` + `consent_outcome.state = 'pending'` + exactly one nudge; the same call replayed → no second nudge; minor on a gated domain → `u18_redirect_required`, zero consent rows, zero OTP sends, profile still created `draft`; adult action key recorded with a server-resolved version; minor action key refused; `channel` persisted correctly per surface; a nudge-send failure not rolling back the participant write.

**Sweep** — a version bump across N users producing exactly N nudges and no duplicates on re-run.

## 7. Out of scope

- **Profile-update consent (#367 §3)** → registry spec. It is a new gate hook point (`item_update`), not channel plumbing.
- Guardian consent on external channels — deliberately impossible, per §3.
- Inbound consent capture by SMS/WhatsApp reply. Nudges link to the app; they never capture.
- Aggregator-side form changes → the QR-registration and bulk-attestation specs in `aggregator-dpg`.
