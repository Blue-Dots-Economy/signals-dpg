# Connect-Flow Consent Simplification — Design

**Status:** spec — awaiting implementation plan
**Author:** brainstorming session, 2026-05-31
**Related:**
- `docs/superpowers/specs/2026-05-28-pii-encryption-at-rest-design.md` — schema-aware masking + decrypt pipeline this design depends on.
- `docs/superpowers/specs/2026-05-26-pii-reveal-on-accepted-action-design.md` — the `reveals_pii_on_status` field this design re-uses as routing signal.
- PR #36 (merged into `feature`) — action-card buttons that already pre-select status; consent flow assumes that UI.

## Goal

Replace the schema-driven free-form action form with a single consent checkbox on both ends of every PII-sharing action:

1. **Initiator** — clicking Connect (or any action whose interaction declares `consent_text_initiator`) opens a modal that shows only that text + a checkbox. Submit is gated on the checkbox.
2. **Receiver** — accepting (or any status transition in `reveals_pii_on_status`) opens a modal with the configured `consent_text_receiver` + a checkbox; submit is gated on the checkbox.
3. **Receiver — reject/cancel/other transitions** keep today's optional `remarks` text field, with the existing dropdown removed (the action-card button now pre-selects the status).
4. The consent acknowledgment (text snapshot + timestamp) lands in the event payload as a tamper-evident audit record, parallel to `status` / `remark`.

## Why now

PR #37 (PII encryption at rest) and PR #36 (counterparty names on the My Actions list) shipped the mechanics of PII-with-consent. The remaining UX friction is the action-create form itself: today an initiator clicking Connect is asked to fill `requirement_schema` fields (role, age, etc. on `apply`; nothing-but-Submit on `connect`), and a receiver responding is asked to pick the status from a dropdown they already implicitly chose by clicking Accept/Reject on the card. Both gates can collapse to a single explicit consent moment, with the configured text providing the legal/UX framing.

The change is also network-themable — purple_dot can ship as consent-only, blue_dot's `apply` can keep its requirement form and append a consent gate underneath.

## Approach (high level)

- Two new optional fields on `NetworkActionInteractionSchema`: `consent_text_initiator`, `consent_text_receiver`. Both strings, non-empty when present, ≤500 chars.
- Two new optional `consent` block on the action request bodies (`PerformActionBodySchema`, `UpdateActionStatusBodySchema`): `{ acknowledged: literal(true), text: string }`. Server attaches `consented_at` on persist.
- Routes (`perform_action.ts`, `update_action_status.ts`) gate the action on the consent block when the interaction declares the matching consent text. Receiver gate only fires when the requested status ∈ `reveals_pii_on_status`.
- Event payload gains a top-level `consent` key alongside `status`/`remark`; snapshot is stored exactly as the client sent it.
- UI: new `<ConsentCheckbox>` primitive; `<ActionModal>` (initiator) and `<ActionStatusUpdater>` (receiver) render the consent path when configured; the receiver's status dropdown is removed (status is pre-selected by the action-card button that opened the modal).
- Config migration: purple_dot empties every `requirement_schema.properties`; both networks add `consent_text_*` to every interaction; blue_dot's `apply` keeps its existing requirement fields.

No DB migration. No Helm changes. No env-var changes.

## Section 1 — Schema additions

### `NetworkActionInteractionSchema` (`packages/schemas/src/network_workflow.ts`)

```ts
const ConsentTextSchema = z.string().trim().min(1).max(500);

const NetworkActionInteractionSchema = z.object({
  // …existing fields unchanged…
  requirement_schema: JsonSchemaSchema,
  event_schema:       JsonSchemaSchema.optional(),
  reveals_pii_on_status: z.array(z.string().min(1)).optional().default([]),

  consent_text_initiator: ConsentTextSchema.optional(),
  consent_text_receiver:  ConsentTextSchema.optional(),
}).superRefine((interaction, ctx) => {
  // Existing reveals_pii_on_status ↔ event_schema check stays.
  // New: if reveals_pii_on_status is non-empty, encourage but don't require
  // consent_text_receiver. Emit a config warning (not a hard error) so existing
  // networks keep parsing.
  if (interaction.reveals_pii_on_status.length > 0 && !interaction.consent_text_receiver) {
    ctx.addIssue({
      code: 'custom',
      severity: 'warning',
      message: 'Interaction declares reveals_pii_on_status but no consent_text_receiver — receiver will not see a consent prompt.',
      path: ['consent_text_receiver'],
    });
  }
});
```

Zod doesn't natively carry warning-severity issues — implementation detail: surface these via the existing config-loader log rather than `ctx.addIssue`. Either way, the rule is non-blocking.

### Request schemas (`packages/schemas/src/api/action_schemas.ts`)

```ts
export const ConsentAckSchema = z.object({
  acknowledged: z.literal(true),
  text: z.string().trim().min(1).max(500),
}).strict();

export const PerformActionBodySchema = z.object({
  // …existing…
  consent: ConsentAckSchema.optional(),
});

export const UpdateActionStatusBodySchema = z.object({
  action_id: z.string().uuid(),
  action_status: z.string(),
  remarks: z.string().optional(),
  consent: ConsentAckSchema.optional(),
});
```

`ConsentAckSchema` is exported so route + UI both import it.

### Event payload

When persisted, the event row's `event_payload` jsonb gains:

```jsonc
{
  "status": "accepted",
  "remark": "optional",
  "consent": {
    "acknowledged": true,
    "text": "I agree to share my contact details (name, email, phone) with the requester.",
    "consented_at": "2026-05-31T09:14:22.518Z"
  }
}
```

- `text` is the literal string the UI captured at click time. The server does not re-resolve it from current network.json. This is the audit invariant — if network.json wording is later edited, prior events still carry what the user actually saw.
- `consented_at` is server-assigned (`new Date().toISOString()`) to prevent client clock skew from confusing the audit trail.
- No new event_schema fields needed — `consent` is a top-level event payload key, parallel to `status`/`remark`.

## Section 2 — UI changes

### New component: `apps/ui/src/components/actions/consent-checkbox.tsx`

Single-purpose primitive. Props: `{ text: string; checked: boolean; onCheckedChange: (b: boolean) => void; }`. Renders the text verbatim (no markdown) inside a card, a `<Checkbox>` with a fixed "I agree" label, and exposes the configured text via `getAttribute('data-consent-text')` so the parent submit handler can read the exact rendered string back when building the request body. This guarantees the snapshot matches what the user saw even if config hot-reloads mid-session.

### `apps/ui/src/components/actions/action-modal.tsx` (initiator)

New render order inside the modal body:

1. `<SchemaForm schema={interaction.requirement_schema}/>` — only when `requirement_schema.properties` is non-empty. Unchanged behaviour otherwise.
2. `<ConsentCheckbox text={interaction.consent_text_initiator}/>` — only when `consent_text_initiator` is non-empty.
3. Footer: Submit button disabled until either (a) no consent checkbox is present, or (b) the checkbox is checked. Form-validity from `<SchemaForm>` continues to gate Submit independently.

Hardcoded subtitle "Share details so the other party can review your request." is dropped. The configured consent text replaces it as the modal's user-facing explanation.

If neither `requirement_schema.properties` nor `consent_text_initiator` is present (back-compat scenario for an under-configured interaction), the modal renders today's "No additional information required" copy and Submit is enabled — i.e. the gate is opt-in per interaction.

Request body assembly: `consent: { acknowledged: true, text: <text just rendered> }` when the checkbox path was used; field omitted otherwise.

### `apps/ui/src/components/actions/action-status-updater.tsx` (receiver)

Today: one form with status dropdown + remarks input + Submit. Replaced with a status-aware form. The status passed in from the action-card button (PR #36 wired Accept / Reject / Cancel / Complete to pre-select the status) drives which branch renders:

- **`status ∈ interaction.reveals_pii_on_status`** (typically `accepted`) AND `consent_text_receiver` is non-empty → **consent branch**: only the `<ConsentCheckbox>`. Submit disabled until checked. Request body carries `consent`, no `remarks`.
- **Otherwise** (reject, cancel, complete, or accept-without-receiver-consent-text) → **reason branch**: an optional `<Textarea>` for `remarks`. Submit always enabled. Request body carries `remarks` (empty omitted), no `consent`.

The status `<Select>` dropdown is deleted. The chosen status is the one the action-card button already pre-selected.

Modal title/verb behaviour stays as PR #36 left it — title carries the action verb ("Accept Request", "Reject Request"), confirm button reads "Submit" universally.

### Other UI files

- `apps/ui/src/lib/action-api.ts` — extend `PerformActionPayload` and `UpdateActionStatusPayload` with the optional `consent` field; no other changes.
- `apps/ui/src/pages/home-page.tsx` and the action-card render path are unchanged — they still open `<ActionModal>` / `<ActionStatusUpdater>` exactly as today.

## Section 3 — Server validation

### `apps/api/src/routes/v1/action/perform_action.ts`

After the existing `getActionInteraction` resolution (which already validates the action_type / from→to / item-type pairing) and **before** the existing `requirement_schema` validation:

```ts
if (interaction.consent_text_initiator?.trim() && !body.consent?.acknowledged) {
  return reply.code(403).send({
    error: 'CONSENT_REQUIRED',
    message: 'Initiator consent acknowledgment required for this action.',
  });
}
```

`consent_text_initiator` empty/missing → no gate, no `consent` field written into the event. When the gate passes, the event payload built downstream includes:

```ts
event_payload.consent = {
  acknowledged: true,
  text: body.consent!.text,
  consented_at: new Date().toISOString(),
};
```

The server stores `body.consent.text` verbatim — no comparison against `interaction.consent_text_initiator`. The client-rendered string is the audit record; race-conditions on config hot-reload don't invalidate the user's consent.

### `apps/api/src/routes/v1/action/update_action_status.ts`

After resolving the interaction and validating the status transition:

```ts
const requiresConsent =
  interaction.reveals_pii_on_status.includes(body.action_status) &&
  !!interaction.consent_text_receiver?.trim();

if (requiresConsent && !body.consent?.acknowledged) {
  return reply.code(403).send({
    error: 'CONSENT_REQUIRED',
    message: 'Receiver consent acknowledgment required to transition to this status.',
  });
}
```

When passed, the existing event-payload builder (which already merges `remarks` from the body when `event_schema` declares `remark`) is extended to merge `body.consent` (with server-stamped `consented_at`) when present. `remarks` and `consent` coexist when both are sent.

### Logging

Both routes log a structured info entry on consent acceptance:

```ts
request.log.info(
  { action_id, side: 'initiator' /* or 'receiver' */, consent_text_length: body.consent.text.length },
  'consent recorded',
);
```

Length, not text — avoids accidentally writing the consent string to logs which might be ingested into systems with different retention from the events table.

### Cross-instance

The consent gate fires at the **user-facing entry point only** — i.e. on the instance the actor (initiator or receiver) is logged into. The downstream mirror endpoints (`POST /api/v1/network/action/perform` on the target instance for create; the corresponding event-mirror endpoint on the source instance for status update) propagate the already-persisted event, including its `consent` snapshot, and do NOT re-gate. Re-gating on the mirror path would either double-count (rejecting a request the originating instance already approved) or, worse, accept a peer-fabricated consent for an action the real user never saw. The originating instance is the one that rendered the text to the user, so it owns the gate.

The peer mirror serializes the event payload as-is, including the `consent` block; no schema change on the mirror endpoint beyond the `event_schema` already carrying it.

### Audit table

`pii_reveal_audit` continues to be written only by the explicit `/contact-details` reveal endpoint (PR #37's posture). The consent snapshot lives in the event payload — queryable via the events log without a parallel audit table. If compliance later wants a denormalized consent log, that's a follow-up; events are the authoritative source.

## Section 4 — Config migration

### `examples/schemas/purple_dot/network.json`

Every interaction's `requirement_schema` is emptied:

```jsonc
"requirement_schema": { "type": "object", "properties": {} }
```

Empty `properties` (rather than removing the key) keeps the JSON Schema valid and downstream parsers happy. The UI treats empty-properties the same as missing → no form rendered.

Every interaction gains:

```jsonc
"consent_text_initiator": "I agree to share my contact details (name, email, phone) with this provider if they accept my request.",
"consent_text_receiver":  "I agree to share my contact details (name, email, phone) with the requester."
```

Same wording across all interactions in purple_dot. Rationale: every interaction in purple_dot shares the same name/email/phone-class PII; per-action wording would be noise.

### `examples/schemas/blue_dot/network.json`

`apply` keeps its existing `requirement_schema` (role, age, workExperience — these are contract data, not PII collected for sharing). It gains:

```jsonc
"consent_text_initiator": "I agree to share my profile contact details with this organization if my application is accepted.",
"consent_text_receiver":  "I agree to share my organisation's contact details with the applicant."
```

Other `connect`-style interactions in blue_dot get the same shorter pair as purple_dot.

### Backward compatibility

Interactions in any network that don't declare either consent string keep their pre-change behaviour exactly. The Zod schema treats both fields as optional; the routes' gates short-circuit when the relevant field is absent.

## Section 5 — Testing

### Unit tests (vitest)

**`packages/schemas`**

- `network_workflow.test.ts`:
  - parses an interaction with both consent strings.
  - parses an interaction without them (back-compat).
  - rejects whitespace-only / >500 char consent strings.
  - non-blocking warning is logged when `reveals_pii_on_status` is non-empty but `consent_text_receiver` is missing (asserted via captured logger).
- `action_schemas.test.ts` (new or extend existing):
  - `ConsentAckSchema` accepts `{acknowledged:true, text:"…"}`.
  - rejects `acknowledged:false`.
  - rejects empty / whitespace text.

**`apps/api/src/routes/v1/action/__tests__`**

- `perform_action.test.ts` — extend:
  - happy path: interaction with `consent_text_initiator` + body carrying valid consent → 200, event payload contains the consent block with server-assigned `consented_at`.
  - gate path: same interaction, body missing consent → `403 CONSENT_REQUIRED`.
  - back-compat: interaction without `consent_text_initiator`, body without consent → 200, no event consent block.
  - snapshot integrity: client-sent `text` is preserved verbatim into event payload even when it diverges from current `consent_text_initiator`.
- `update_action_status.test.ts` — extend:
  - status ∈ `reveals_pii_on_status` + receiver consent text declared, no body consent → `403 CONSENT_REQUIRED`.
  - status ∉ `reveals_pii_on_status` (reject, cancel) → `remarks` flow unchanged; no consent enforced even if interaction declares one.
  - both `remarks` and `consent` can coexist on an accepted action.

### UI tests

Only added if the repo already has UI test infra in place (check before scaffolding new infrastructure). If present:

- `consent-checkbox.tsx` renders text verbatim; Submit disabled until checked.
- `action-modal.tsx`: empty `requirement_schema` + declared `consent_text_initiator` renders only the checkbox path; populated requirement_schema renders form + checkbox; neither present → legacy copy.
- `action-status-updater.tsx`: opened with status ∈ reveals → consent branch; opened with status ∉ reveals → reason branch.

### Integration tests

Extend `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts` (or add `consent_flow.integration.test.ts`):

- `POST /api/v1/action/perform` with consent → event row in DB carries the snapshot.
- `POST /api/v1/action/update-status` to `accepted` with consent → event row carries the snapshot.
- Same status without consent → 403.

The existing `get_action_contact_details.integration.test.ts` end-to-end coverage stays — it asserts the encrypted-PII reveal flow still works post-consent.

### Manual smoke (PR test plan)

- **purple_dot Connect** from search → modal shows configured consent text + checkbox only; Submit disabled until checked; submit succeeds; action lands on My Actions.
- **purple_dot Accept** from action card → modal shows receiver consent text + checkbox; no dropdown; Submit succeeds; counterparty name decrypts (validates wiring with PR #36 fix).
- **purple_dot Reject** → modal shows optional reason textarea only; no dropdown; submit with empty reason succeeds; submit with reason persists it.
- **blue_dot Apply** → modal renders existing requirement form (role/age/workExperience) AND the consent checkbox below; Submit disabled until form valid AND checkbox checked.
- Regression: interaction with no consent strings configured behaves exactly like today.

## What stays out of scope

- **Per-status receiver consent text.** Today every interaction declares only `["accepted"]` in `reveals_pii_on_status`. If a network later configures multiple reveal-statuses with materially different wording needs, revisit and let `consent_text_receiver` become a map keyed by status.
- **Per-domain consent text overrides.** Single string per interaction is enough until proven otherwise.
- **Dedicated consent audit table.** The event payload is the source of truth; building a denormalized index is a follow-up if compliance asks.
- **Markdown / HTML in consent text.** Plain-text only, escaped on render. Keeps the surface area small and prevents accidental injection.
- **Re-consent on config change.** If `consent_text_*` is edited in network.json, prior actions retain their original snapshots; in-flight pending actions are NOT forced to re-acknowledge. The snapshot semantics mean the user agreed to what they saw, which is enough.
- **i18n / translated consent text.** Single-language. Internationalisation is a separate workstream.
- **UI changes outside the two modals.** Action-card buttons, action-list filters, theme provider, network chip — all unchanged from PR #36.

## Open question (resolved before plan)

None — every architectural question was answered during brainstorming. Implementation plan can proceed.
