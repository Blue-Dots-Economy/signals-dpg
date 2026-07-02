# Consent v1 — Phase 2: Terms & Privacy popup + gate + pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture explicit terms/privacy consent at login via a themed tabbed popup (variant A), gated so first-time / version-bumped users must accept before entering the app, while returning users on the current version are not interrupted; plus always-available `/privacy` `/terms` pages and footer links.

**Architecture:** UI-merge + backend-ledger (spec §1.1). Backend exposes `GET /consent/status` (accepted versions per category) + `POST /consent/accept` (writes `consent_record` rows). The UI fetches the served `consent_config` entries (network-default + brand-scoped from Phase 1), merges the brand override, renders `current_version` content as Markdown, computes `needs_consent`, and gates the post-OTP step.

**Tech Stack:** Fastify + Zod, Drizzle, React 19 + Vite, react-router, shadcn Dialog/Tabs, react-markdown + remark-gfm, vitest.

## Global Constraints

- Files & DB columns snake_case; module fn exports camelCase, route handler exports snake_case; Zod schemas PascalCase.
- ESM only, strict TS, no `any`, `import type` for type-only imports. No `// TODO`, no `console.log` in library code.
- Routes never throw across boundaries — `reply.code(N).send({ error, message })` with machine-readable `error`.
- `network` on write is validated against the instance's `served_domains`; `brand`/`version` are client-supplied (v1). `terms`+`privacy` are recorded as **two separate rows** on one accept.
- Popup = **layout Variant A** (top segmented tabs `Privacy Policy` | `Terms of Service`), themed with the existing `bg-brand-cta` class (no hardcoded colors). Checkbox **never pre-checked**; Accept disabled until checked.
- Re-consent (version bump) applies to **terms/privacy only**. Prototype reference: `docs/superpowers/prototypes/consent-popup-prototype.html`.
- Consent categories in this phase: `terms`, `privacy` (both `level: 'user'`). `document_version` recorded = the `current_version` the UI displayed.

## Interfaces produced by Phase 1 (already on branch, do not rebuild)

- `@dpg/schemas`: `ConsentConfigSchema`, `PartialConsentConfigSchema`, `ConsentConfigDocument`, `parseConsentConfigDocument`. A document is `{ current_version, versions: [{ version, title?, content?, statement?, effective_from }] }`. `documents.terms`/`documents.privacy` carry `title`+`content` (Markdown); `documents.profile_creation` + actions carry `statement`.
- `apps/api/db/postgres/schema` exports the `consent_record` table (Drizzle): columns `id, seq, level, consentCategory, actionType, actionStage, userId, itemId, actionId, network, brand, documentVersion, source, acceptedAt, createdAt, metadata`.
- Backend serves consent config via `GET /api/v1/network/schemas?network=` entries with `kind: 'consent_config'` (network default → no `brand`; brand override → `brand` set).
- `apiConfig.served_domains` (array of `{ network, domain, key }`).

---

## File Structure

- Create `packages/schemas/src/api/consent_schemas.ts` — request/response Zod schemas; re-export from `packages/schemas/src/index.ts`.
- Create `apps/api/src/routes/v1/consent/get_consent_status.ts`, `accept_consent.ts`, `consent_routes.ts`; register in `apps/api/src/routes/v1/v1_routes.ts`.
- Create `apps/api/src/routes/v1/consent/__tests__/consent.integration.test.ts`.
- Modify `apps/ui/package.json` — add `react-markdown`, `remark-gfm`.
- Create `apps/ui/src/components/consent/markdown.tsx` — sanitized Markdown renderer wrapper.
- Create `apps/ui/src/lib/consent-api.ts` — `fetchConsentConfigs`, `getConsentStatus`, `acceptConsent`.
- Create `apps/ui/src/hooks/use-consent-config.ts` — fetch + brand-merge → merged `ConsentConfig`; `use-consent-gate.ts` — computes which docs need consent.
- Create `apps/ui/src/components/consent/consent-modal.tsx` — variant-A modal (gate + view modes).
- Create `apps/ui/src/pages/legal/privacy-page.tsx`, `terms-page.tsx`.
- Modify `apps/ui/src/pages/auth/otp-page.tsx` (gate injection), `apps/ui/src/components/layout/auth-footer.tsx` (links open modal), `apps/ui/src/app.tsx` (routes).
- Modify `apps/ui/src/lib/network-api.ts` — add `'consent_config'` to the `CachedSchemaEntry['kind']` union.

---

## Task 1: Backend — consent status + accept endpoints

**Files:**
- Create: `packages/schemas/src/api/consent_schemas.ts`; modify `packages/schemas/src/index.ts`
- Create: `apps/api/src/routes/v1/consent/get_consent_status.ts`, `accept_consent.ts`, `consent_routes.ts`; modify `apps/api/src/routes/v1/v1_routes.ts`
- Test: `apps/api/src/routes/v1/consent/__tests__/consent.integration.test.ts`

**Interfaces produced:**
- `GET /api/v1/consent/status?network=<id>` (auth) → `{ statuses: { terms: number[]; privacy: number[] } }` — distinct accepted `document_version`s for the caller, per user-level category.
- `POST /api/v1/consent/accept` (auth) → body `{ network: string; brand?: string; source: 'signup'|'login'; items: Array<{ category: 'terms'|'privacy'; version: number }> }` → writes one `consent_record` row per item (`level:'user'`, `userId:req.user.id`); returns `{ recorded: number }`. `network` must match a `served_domains` network else `400 UNKNOWN_NETWORK`.

- [ ] **Step 1: Zod schemas.** In `packages/schemas/src/api/consent_schemas.ts`:

```typescript
import z from 'zod';

export const UserConsentCategorySchema = z.enum(['terms', 'privacy']);

export const ConsentStatusQuerySchema = z.object({ network: z.string().min(1) });
export const ConsentStatusResponseSchema = z.object({
  statuses: z.object({
    terms: z.array(z.number().int()),
    privacy: z.array(z.number().int()),
  }),
});

export const ConsentAcceptItemSchema = z.object({
  category: UserConsentCategorySchema,
  version: z.number().int().min(1),
});
export const ConsentAcceptBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  source: z.enum(['signup', 'login']),
  items: z.array(ConsentAcceptItemSchema).min(1),
});
export const ConsentAcceptResponseSchema = z.object({ recorded: z.number().int() });

export type ConsentStatusResponse = z.infer<typeof ConsentStatusResponseSchema>;
export type ConsentAcceptBody = z.infer<typeof ConsentAcceptBodySchema>;
```

Re-export from `packages/schemas/src/index.ts`: `export * from './api/consent_schemas';`

- [ ] **Step 2: Status handler.** `apps/api/src/routes/v1/consent/get_consent_status.ts` — mirror the `get_action_contact_details.ts` route shape (`FastifyPluginAsyncZod`, `preHandler: auth_middleware_if_enabled`). Handler:
  - `const userId = request.user?.id; if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '...' });`
  - Query `consent_record` where `userId = userId AND level = 'user' AND network = query.network AND consentCategory IN ('terms','privacy')`, select distinct `consentCategory, documentVersion`.
  - Build `{ statuses: { terms: number[], privacy: number[] } }` from the rows (empty arrays if none).
  - Use `db` from `@api/db/postgres/drizzle_config`, `consent_record` from `@api/db/postgres/schema`, `and/eq/inArray` from `drizzle-orm`.

- [ ] **Step 3: Accept handler.** `apps/api/src/routes/v1/consent/accept_consent.ts`:
  - Auth: 401 if no `request.user?.id`.
  - Validate `body.network` is one of `apiConfig.served_domains.map(b => b.network)`; else `reply.code(400).send({ error: 'UNKNOWN_NETWORK', message })`. Import `apiConfig` from `@/config`.
  - Insert one row per `body.items[i]`: `{ level: 'user', consentCategory: item.category, userId, network: body.network, brand: body.brand ?? null, documentVersion: item.version, source: body.source, acceptedAt: new Date() }`.
  - Return `{ recorded: items.length }`. Wrap DB errors → `reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message })` (log with `request.log.error`).

- [ ] **Step 4: Route group + registration.** `consent_routes.ts` registers both routes; add to `v1_routes.ts`: `import consent_routes from '@/routes/v1/consent/consent_routes';` and `fastify.register(consent_routes, { prefix: '/consent' });`

- [ ] **Step 5: Integration test** (`consent.integration.test.ts`) — use the existing integration harness (see `apps/api/src/routes/v1/__tests__/integration_helpers.ts` and existing `*.integration.test.ts` for auth/setup). Assert:
  1. `POST /accept` with `{network:'blue_dot', source:'signup', items:[{category:'terms',version:1},{category:'privacy',version:1}]}` → `recorded: 2`; two rows exist for the user.
  2. `GET /status?network=blue_dot` → `{ statuses: { terms: [1], privacy: [1] } }`.
  3. `POST /accept` with an unknown network → `400 UNKNOWN_NETWORK`.
  4. A second accept of terms v2 → `GET /status` returns `terms: [1,2]` (both retained).

- [ ] **Step 6: Verify** — `pnpm typecheck`; `docker compose up -d db redis && pnpm --filter api test:integration consent`. Both pass. (If the DB lacks the table, `pnpm db:push:api` or apply `apps/api/db/postgres/schema.sql`.)

- [ ] **Step 7: Commit** — `feat(api): consent status + accept endpoints (#99)`

---

## Task 2: UI — Markdown + consent-api + brand-merge hook

**Files:**
- Modify: `apps/ui/package.json` (deps), `apps/ui/src/lib/network-api.ts` (kind union)
- Create: `apps/ui/src/components/consent/markdown.tsx`, `apps/ui/src/lib/consent-api.ts`, `apps/ui/src/hooks/use-consent-config.ts`, `apps/ui/src/hooks/use-consent-gate.ts`
- Test: `apps/ui/src/hooks/__tests__/use-consent-config.test.ts` (merge logic — pure function extracted)

**Interfaces produced:**
- `mergeConsentConfig(networkDefault, brandOverride?)` — deep-merges brand override per top-level document over the network default; returns a full `ConsentConfig`. Exported pure fn for testing.
- `fetchConsentConfigs(networkId): Promise<Array<{ brand: string | null; schema: ConsentConfig }>>`
- `getConsentStatus(networkId): Promise<{ statuses: { terms: number[]; privacy: number[] } }>`
- `acceptConsent(body): Promise<{ recorded: number }>` (body matches `ConsentAcceptBody`).
- `useConsentConfig()` hook → `{ config, isLoading }` (merged, for the active network+brand).
- `useConsentGate()` hook → `{ needed: Array<'terms'|'privacy'>, config, currentVersions, isLoading, refetch }` where `needed` = categories whose `current_version` is NOT in the accepted set.

- [ ] **Step 1: Add deps.** Add to `apps/ui/package.json` dependencies: `"react-markdown": "^9.0.1"`, `"remark-gfm": "^4.0.0"`. Run `pnpm install`.

- [ ] **Step 2: Markdown wrapper.** `apps/ui/src/components/consent/markdown.tsx` — a small component using `react-markdown` + `remark-gfm`, no `rehype-raw` (raw HTML NOT rendered → safe). Apply Tailwind `prose`-like classes for readable text. Signature: `export function Markdown({ children }: { children: string }) { ... }`.

- [ ] **Step 3: network-api kind union.** In `apps/ui/src/lib/network-api.ts`, add `'consent_config'` to the `CachedSchemaEntry['kind']` union and add an optional `brand?: string` field.

- [ ] **Step 4: consent-api.** `apps/ui/src/lib/consent-api.ts`:
  - `fetchConsentConfigs(networkId)`: GET `/api/v1/network/schemas?network=<id>`, filter `kind === 'consent_config'`, return `[{ brand: e.brand ?? null, schema: e.schema }]`.
  - `getConsentStatus(networkId)`: GET `/api/v1/consent/status?network=<id>` (authenticated client — reuse the same axios client that carries the auth token, e.g. `apiClient` from `@/lib/api-client`).
  - `acceptConsent(body)`: POST `/api/v1/consent/accept`.
  - Types imported from `@dpg/schemas` where available (`ConsentAcceptBody`).

- [ ] **Step 5: merge + hooks.** In `use-consent-config.ts` define and export a pure `mergeConsentConfig(networkDefault, brandOverride)` that returns `{ documents: { terms, privacy, profile_creation }, actions }` where each brand-provided top-level document REPLACES the network default's (per spec §4.3), and everything absent inherits. `useConsentConfig()` resolves the active network id + brand (reuse `useNetworkTheme()` from `@/theme/theme-provider` → `{ themeId, brand }`), fetches via `fetchConsentConfigs`, picks the `brand === null` entry as default and the `brand === activeBrand` entry as override, merges, returns via react-query (`useQuery`, 5-min staleTime, key `['consent-config', themeId, brand]`).
  `use-consent-gate.ts`: `useConsentGate()` calls `useConsentConfig()` + `getConsentStatus(themeId)`; `currentVersions = { terms: config.documents.terms.current_version, privacy: config.documents.privacy.current_version }`; `needed = (['terms','privacy'] as const).filter(c => !status.statuses[c].includes(currentVersions[c]))`. Expose `refetch`.

- [ ] **Step 6: merge unit test** (`use-consent-config.test.ts`) — test `mergeConsentConfig`: (a) brand override of `privacy` replaces only privacy, keeps default terms/profile_creation/actions; (b) no brand override → returns default unchanged; (c) brand `current_version` is honored over default's.

- [ ] **Step 7: Verify** — `pnpm typecheck`; `pnpm --filter ui exec vitest run src/hooks/__tests__/use-consent-config.test.ts`. Pass.

- [ ] **Step 8: Commit** — `feat(ui): consent config fetch + brand merge + markdown (#99)`

---

## Task 3: UI — ConsentModal (variant A, gate + view modes)

**Files:**
- Create: `apps/ui/src/components/consent/consent-modal.tsx`
- Test: `apps/ui/src/components/consent/__tests__/consent-modal.test.tsx` (render + gating behavior)

**Interfaces produced:**
- `<ConsentModal open mode initialTab config onAccept onOpenChange />` where `mode: 'gate' | 'view'`, `initialTab: 'privacy' | 'terms'`, `config` = merged `ConsentConfig`. In `gate` mode: not closeable by backdrop/Esc, checkbox + Accept (disabled until checked), `onAccept()` fires when Accept clicked. In `view` mode: closeable, no checkbox/Accept (read-only tabs).

- [ ] **Step 1: Component.** Build with shadcn `Dialog`, `Tabs` (`TabsList`/`TabsTrigger`/`TabsContent`), the `Markdown` component, `Checkbox`, and a button styled `bg-brand-cta hover:brightness-110`. Render:
  - Header: brand line (network display name), title "Review & accept to continue" (gate) / doc title (view), lead text.
  - Top segmented tabs: `Privacy Policy` (renders `config.documents.privacy` current version's `title`+`content`) and `Terms of Service` (`config.documents.terms`). Look up current version content: `doc.versions.find(v => v.version === doc.current_version)`.
  - `gate` mode footer: unchecked `Checkbox` + label "I have read and agree to the Terms of Service and Privacy Policy." + Accept button `disabled={!checked}` calling `onAccept`. Dialog `onOpenChange` ignored / prevented in gate mode (no dismiss).
  - `view` mode: no footer checkbox/button; standard closeable Dialog.
- Content is Markdown → render via `<Markdown>{content}</Markdown>`.

- [ ] **Step 2: Test** (`consent-modal.test.tsx`, jsdom): (a) gate mode: Accept disabled until checkbox checked, then enabled; clicking Accept calls `onAccept`. (b) tabs switch between privacy and terms content. (c) view mode: no checkbox/Accept rendered. Use `@testing-library/react` (already used in the UI — verify; if not present, assert via a lighter render). If the UI has no component test harness, keep the test to the pure helper that picks current-version content and note it.

- [ ] **Step 3: Verify** — `pnpm typecheck`; run the modal test. Pass.

- [ ] **Step 4: Commit** — `feat(ui): consent modal (variant A, gate + view) (#99)`

---

## Task 4: UI — wire the gate, footer links, and legal pages

**Files:**
- Modify: `apps/ui/src/pages/auth/otp-page.tsx`, `apps/ui/src/components/layout/auth-footer.tsx`, `apps/ui/src/app.tsx`
- Create: `apps/ui/src/pages/legal/privacy-page.tsx`, `apps/ui/src/pages/legal/terms-page.tsx`

**Interfaces consumed:** `useConsentGate`, `acceptConsent`, `ConsentModal`, `useConsentConfig`.

- [ ] **Step 1: Gate in otp-page.** In `handleOtpComplete`, after the existing domain gate (`if (scope) { ... }`) and BEFORE the success toast/navigate:
  - Resolve `{ themeId, brand }` via `useNetworkTheme()`; fetch gate state (`getConsentStatus` + merged config — reuse `useConsentGate` state or an imperative helper). Compute `needed`.
  - If `needed.length > 0`: set component state to show `<ConsentModal mode="gate">` with the merged `config`, and DO NOT navigate yet. The modal's `onAccept` → call `acceptConsent({ network: themeId, brand, source: state.userExists ? 'login' : 'signup', items: needed.map(c => ({ category: c, version: config.documents[c].current_version })) })`, then navigate to `state.redirectTo ?? '/'`.
  - If `needed.length === 0`: navigate as today (unchanged behavior for returning users).
  - Render the `<ConsentModal>` in the page JSX, controlled by the new state.
  - On modal (gate) there is no cancel-that-proceeds; a "not now" affordance should `signOut()` + stay on login (optional — keep minimal: gate has only Accept).

- [ ] **Step 2: Footer links open the modal (view mode).** In `auth-footer.tsx`, replace the `<a href="/privacy">` / `<a href="/terms">` with buttons that open a `<ConsentModal mode="view" initialTab="privacy"|"terms">` using `useConsentConfig()`. Keep them as underlined text (same styling). Keep `href` fallback to `/privacy` `/terms` if config not yet loaded is unnecessary — open the modal.

- [ ] **Step 3: Legal pages.** `privacy-page.tsx` / `terms-page.tsx` render the current-version `title`+`content` (Markdown) from `useConsentConfig()` in a simple centered page layout (reuse an existing page shell if one exists; otherwise a plain container). These are public (pre-login) routes.

- [ ] **Step 4: Routes.** In `app.tsx`, add inside `<Routes>` (outside `RequireAuth`): `<Route path="/privacy" element={<PrivacyPage />} />` and `<Route path="/terms" element={<TermsPage />} />`.

- [ ] **Step 5: Verify** — `pnpm typecheck`; `pnpm --filter ui exec tsc --noEmit`. Then a manual smoke via the run-signals-dpg flow is expected (controller will do end-to-end). Ensure no build/type errors.

- [ ] **Step 6: Commit** — `feat(ui): wire consent gate at login + footer links + /privacy /terms (#99)`

---

## Phase 2 Done — Verification

- `pnpm typecheck` clean.
- Backend: `pnpm --filter api test:integration consent` passes.
- UI unit tests (merge + modal) pass.
- Manual end-to-end (controller): new user login → popup appears, Accept required, then lands in app; same user logs in again → NO popup; footer Privacy/Terms open the popup read-only on the right tab; `/privacy` `/terms` render content; bump `blue_dot` terms `current_version` in `consent.json` → next login re-prompts.

## Notes

- `terms`+`privacy` accepted together write **two rows** (one per category), each with its own version.
- Gate is client-side (spec §1.1 tradeoff). Action-consent required-ness (Phase 4) remains server-enforced.
- If `@testing-library/react` is absent in the UI, keep component tests to exported pure helpers and note the manual coverage; do not add a heavy test harness just for this.
