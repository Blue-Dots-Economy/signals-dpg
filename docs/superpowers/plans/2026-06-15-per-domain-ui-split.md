# Per-domain Signals UI split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the same signals UI build run as per-domain instances chosen by one runtime config value `VITE_SERVED_BINDING=<network>/<domain>` — pinning the network + acting domain, scoping browse to that domain's interaction targets, locking profile creation to it (no picker), and blocking cross-domain login after OTP. Unset key = today's behavior.

**Architecture:** One new runtime key read via the existing `config.js`/`getRuntimeEnv` layer, parsed once by a small `served-binding` module and consulted at each domain-resolution point. Three new pure helpers (`served-binding`, `visible-domains`, `domain-gate`) plus targeted edits to `home-page.tsx`, `profile-form-page.tsx`, and the auth/OTP flow. No backend, Vite, or Dockerfile change.

**Tech Stack:** React 19 + Vite + react-router, TypeScript (ESM, strict, no `any`), Vitest, react-i18next. Branch: `feat/per-domain-ui-split` (from `feature`).

**Spec:** `docs/superpowers/specs/2026-06-15-per-domain-ui-split-design.md`

**Commands:** UI typecheck via `pnpm typecheck` (api+ui). UI tests: `pnpm --filter ui exec vitest run <file>`. Node 24: `source ~/.nvm/nvm.sh && nvm use 24` before running. Do NOT run Codacy (MCP not connected here).

**Precedence rule used throughout:** acting domain = `?as=` (local test override) → `servedBinding.domain` → `myItem.item_domain` → fallback. Browse scoping (`viewerDomain`) = `?as=` → `servedBinding.domain` → `myItem.item_domain` → `null`. A signed-in user is scoped to their own domain's targets in both the bound portals and the combined UI; `null` (only a signed-out / no-profile visitor) ⇒ network-wide browse.

---

### Task 1: `served-binding` module + env type

**Files:**
- Create: `apps/ui/src/lib/served-binding.ts`
- Modify: `apps/ui/src/vite-env.d.ts`
- Test: `apps/ui/src/lib/served-binding.test.ts`

- [ ] **Step 1: Add the env key type.** In `apps/ui/src/vite-env.d.ts`, inside `interface ImportMetaEnv`, add after the `VITE_NETWORK_ID` line:

```ts
  readonly VITE_SERVED_BINDING?: string;
```

- [ ] **Step 2: Create the module.** `apps/ui/src/lib/served-binding.ts`:

```ts
import { getRuntimeEnv } from '@/lib/runtime-env';

export interface ServedBinding {
  network: string;
  domain: string;
}

/**
 * Parses a "<network>/<domain>" binding string (e.g. "purple_dot/provider").
 * Returns null for unset / blank / malformed input (missing half, extra slash).
 * Pure — exported separately so it can be unit-tested without runtime config.
 */
export function parseServedBinding(raw: string | null | undefined): ServedBinding | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const network = trimmed.slice(0, slash).trim();
  const domain = trimmed.slice(slash + 1).trim();
  if (!network || !domain || domain.includes('/')) return null;
  return { network, domain };
}

/**
 * The network/domain this UI instance is scoped to, from the runtime config
 * key VITE_SERVED_BINDING. Null when unset/malformed — the UI then runs in its
 * legacy multi-domain mode (domain derived from the logged-in user's profile).
 */
export function getServedBinding(): ServedBinding | null {
  return parseServedBinding(getRuntimeEnv('VITE_SERVED_BINDING') as string | undefined);
}
```

- [ ] **Step 3: Write the test.** `apps/ui/src/lib/served-binding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseServedBinding } from './served-binding';

describe('parseServedBinding', () => {
  it('parses a valid network/domain pair', () => {
    expect(parseServedBinding('purple_dot/provider')).toEqual({
      network: 'purple_dot',
      domain: 'provider',
    });
  });
  it('trims surrounding whitespace', () => {
    expect(parseServedBinding('  purple_dot/seeker  ')).toEqual({
      network: 'purple_dot',
      domain: 'seeker',
    });
  });
  it.each([undefined, null, '', '   ', 'purple_dot', '/provider', 'purple_dot/', 'a/b/c'])(
    'returns null for malformed input %p',
    (input) => {
      expect(parseServedBinding(input as string | null | undefined)).toBeNull();
    },
  );
});
```

- [ ] **Step 4: Run the test — expect PASS.** `pnpm --filter ui exec vitest run src/lib/served-binding.test.ts`

- [ ] **Step 5: Typecheck — expect exit 0.** `pnpm typecheck`

- [ ] **Step 6: Commit.**

```bash
git add apps/ui/src/lib/served-binding.ts apps/ui/src/lib/served-binding.test.ts apps/ui/src/vite-env.d.ts
git commit -m "feat(ui): served-binding config (VITE_SERVED_BINDING network/domain)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `computeVisibleDomains` helper

**Files:**
- Create: `apps/ui/src/lib/visible-domains.ts`
- Test: `apps/ui/src/lib/visible-domains.test.ts`

- [ ] **Step 1: Create the helper.** `apps/ui/src/lib/visible-domains.ts`:

```ts
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';

/**
 * Browseable domains for a given viewer.
 *
 * Visibility derives from the network's interaction edges
 * (actions.*.interactions[], each a from_domain -> to_domain pair): a viewer
 * sees domain Y iff an interaction exists where from = the viewer's own domain
 * and to = Y — i.e. you browse exactly what you can initiate toward.
 *
 * - viewerDomain null: no domain identity, so every browseable domain (every
 *   distinct to_domain) is returned — today's legacy behavior.
 * - Cross-network edges (from_network other than this network) are ignored.
 */
export function computeVisibleDomains(
  network: DotNetworkSchema,
  viewerDomain: string | null,
): DotNetworkDomain[] {
  const toDomains = new Set<string>();
  for (const action of Object.values(network.actions)) {
    for (const interaction of action.interactions) {
      if (viewerDomain) {
        const fromNetwork = interaction.from_network ?? network.id;
        if (interaction.from_domain !== viewerDomain || fromNetwork !== network.id) {
          continue;
        }
      }
      toDomains.add(interaction.to_domain);
    }
  }
  return network.domains.filter((d) => toDomains.has(d.id));
}
```

- [ ] **Step 2: Write the test.** `apps/ui/src/lib/visible-domains.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DotNetworkSchema } from '@/engine/types';
import { computeVisibleDomains } from './visible-domains';

function makeNetwork(): DotNetworkSchema {
  return {
    id: 'purple_dot',
    domains: [
      { id: 'seeker', description: 'Seeker' },
      { id: 'provider', description: 'Provider' },
    ],
    actions: {
      connect: {
        description: 'connect',
        interactions: [
          { from_domain: 'seeker', to_domain: 'provider', requirement_schema: {} },
          { from_domain: 'provider', to_domain: 'seeker', requirement_schema: {} },
          { from_domain: 'provider', to_domain: 'provider', requirement_schema: {} },
        ],
      },
    },
  } as unknown as DotNetworkSchema;
}

const ids = (n: DotNetworkSchema, v: string | null) =>
  computeVisibleDomains(n, v).map((d) => d.id);

describe('computeVisibleDomains', () => {
  it('seeker sees only providers', () => {
    expect(ids(makeNetwork(), 'seeker')).toEqual(['provider']);
  });
  it('provider sees seeker and provider', () => {
    expect(ids(makeNetwork(), 'provider')).toEqual(['seeker', 'provider']);
  });
  it('null viewer sees all browseable domains', () => {
    expect(ids(makeNetwork(), null)).toEqual(['seeker', 'provider']);
  });
  it('a domain with no outgoing edge sees nothing', () => {
    const n = makeNetwork();
    n.actions.connect.interactions = n.actions.connect.interactions.filter(
      (i) => i.from_domain !== 'provider',
    );
    expect(ids(n, 'provider')).toEqual([]);
  });
  it('ignores cross-network from_network edges', () => {
    const n = makeNetwork();
    n.actions.connect.interactions.push({
      from_network: 'yellow_dot',
      from_domain: 'seeker',
      to_domain: 'seeker',
      requirement_schema: {},
    } as DotNetworkSchema['actions'][string]['interactions'][number]);
    expect(ids(n, 'seeker')).toEqual(['provider']);
  });
});
```

- [ ] **Step 3: Run the test — expect PASS.** `pnpm --filter ui exec vitest run src/lib/visible-domains.test.ts`

- [ ] **Step 4: Commit.**

```bash
git add apps/ui/src/lib/visible-domains.ts apps/ui/src/lib/visible-domains.test.ts
git commit -m "feat(ui): computeVisibleDomains (viewer-scoped browse domains)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `domain-gate` helper (pure decision) + held-domains resolver

**Files:**
- Create: `apps/ui/src/lib/domain-gate.ts`
- Test: `apps/ui/src/lib/domain-gate.test.ts`

- [ ] **Step 1: Create the module.** `apps/ui/src/lib/domain-gate.ts`:

```ts
import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';

export type DomainGate = { allow: true } | { allow: false; heldDomain: string };

/**
 * Decides whether a user may use a UI bound to `boundDomain`, given the domains
 * they already hold profiles in (within the bound network). Blocks when they
 * hold a profile in any OTHER domain; allows when they hold none (new user) or
 * only the bound domain. Pure.
 */
export function evaluateDomainGate(heldDomains: string[], boundDomain: string): DomainGate {
  const other = heldDomains.find((d) => d !== boundDomain);
  return other ? { allow: false, heldDomain: other } : { allow: true };
}

/**
 * The distinct domains in which the signed-in user holds a profile within
 * `networkId`. Fetches the network config to enumerate domains, then probes
 * each for a created-by-me item. I/O wrapper around evaluateDomainGate; best
 * effort (a failed probe counts as "no item" for that domain).
 */
export async function resolveHeldDomains(
  networkId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const network = await fetchNetworkConfig(networkId);
  const perDomain = await Promise.all(
    network.domains.map((domain) => {
      const itemType = Object.keys(domain.item_schemas ?? {})[0] ?? 'profile';
      return fetchItems(
        {
          item_network: networkId,
          item_domain: domain.id,
          item_type: itemType,
          created_by_me: true,
          limit: 1,
        },
        signal,
      )
        .then((res) => (res.items.length > 0 ? domain.id : null))
        .catch(() => null);
    }),
  );
  return perDomain.filter((d): d is string => d !== null);
}
```

> Verify the call shapes against the current code before writing: `fetchNetworkConfig(id)` returns a network with `.domains` (see `home-page.tsx`), and `fetchItems({ item_network, item_domain, item_type, created_by_me, limit }, signal)` returns `{ items }` (see `profile-form-page.tsx:209-225`). Adjust property names only if they differ.

- [ ] **Step 2: Write the test** (pure function only). `apps/ui/src/lib/domain-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateDomainGate } from './domain-gate';

describe('evaluateDomainGate', () => {
  it('allows a new user with no profiles', () => {
    expect(evaluateDomainGate([], 'provider')).toEqual({ allow: true });
  });
  it('allows a user whose profile is in the bound domain', () => {
    expect(evaluateDomainGate(['provider'], 'provider')).toEqual({ allow: true });
  });
  it('blocks a user whose profile is in another domain (names it)', () => {
    expect(evaluateDomainGate(['seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
  it('blocks when any held domain differs from the bound domain', () => {
    expect(evaluateDomainGate(['provider', 'seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
});
```

- [ ] **Step 3: Run the test — expect PASS.** `pnpm --filter ui exec vitest run src/lib/domain-gate.test.ts`

- [ ] **Step 4: Typecheck — expect exit 0.** `pnpm typecheck`

- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/lib/domain-gate.ts apps/ui/src/lib/domain-gate.test.ts
git commit -m "feat(ui): domain-gate (evaluateDomainGate + resolveHeldDomains)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the binding into Browse (`home-page.tsx`)

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`

- [ ] **Step 1: Import the helpers.** Add near the other `@/lib` imports (after the `enum-filters` import):

```ts
import { getServedBinding } from '@/lib/served-binding';
import { computeVisibleDomains } from '@/lib/visible-domains';
```

- [ ] **Step 2: Pin the network from the binding.** Replace the network-resolution block (currently lines ~206-214):

```ts
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  
  // Get network from URL query param, fallback to env config
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId = networkFromUrl && configuredNetworkIds.includes(networkFromUrl)
    ? networkFromUrl
    : (configuredNetworkIds[0] || null);
  
  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
```

with:

```ts
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  const servedBinding = getServedBinding();

  // Network: the served binding pins it; otherwise URL param, then env config.
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId =
    servedBinding?.network ??
    (networkFromUrl && configuredNetworkIds.includes(networkFromUrl)
      ? networkFromUrl
      : (configuredNetworkIds[0] || null));

  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
```

- [ ] **Step 3: Derive acting domain + viewer domain from the binding; scope visibleDomains.** Replace the `currentDomain` + `visibleDomains` block (currently lines ~388-403):

```ts
  // Current domain: from ?as= param (demo override), active profile, or network default
  const currentDomain = searchParams.get('as') ?? myItem?.item_domain ?? network?.domains[0]?.id ?? 'student_profile';

  // Browseable domains = the distinct `to_domain`s across all interactions in
  // the network. ...
  const visibleDomains = React.useMemo(() => {
    if (!network) return [];
    const toDomains = new Set(
      getAllInteractions(network).map(({ interaction }) => interaction.to_domain)
    );
    return network.domains.filter((d) => toDomains.has(d.id));
  }, [network]);
```

with:

```ts
  // Acting domain: ?as= test override → served binding → active profile →
  // network default. Drives connect-action source (from_domain).
  const currentDomain =
    searchParams.get('as') ??
    servedBinding?.domain ??
    myItem?.item_domain ??
    network?.domains[0]?.id ??
    'student_profile';

  // Viewer domain for Browse scoping: ?as= → served binding → the logged-in
  // user's own profile domain → null. A signed-in user is scoped to their
  // domain's interaction targets in BOTH the bound portals and the combined UI
  // (a seeker never sees other seekers). Null — only a signed-out / no-profile
  // visitor — means network-wide browse (computeVisibleDomains).
  const viewerDomain =
    searchParams.get('as') ?? servedBinding?.domain ?? myItem?.item_domain ?? null;

  const visibleDomains = React.useMemo(
    () => (network ? computeVisibleDomains(network, viewerDomain) : []),
    [network, viewerDomain],
  );
```

- [ ] **Step 4: Remove the now-unused `getAllInteractions`.** Delete its definition (currently lines ~101-109). After this it is unused in the file. If `DotNetworkInteraction` becomes an unused import as a result, remove it from the `@/engine/types` import list too (typecheck in Step 6 will confirm).

```ts
function getAllInteractions(network: DotNetworkSchema): Array<{ actionType: string; interaction: DotNetworkInteraction }> {
  const interactions: Array<{ actionType: string; interaction: DotNetworkInteraction }> = [];
  for (const [actionType, action] of Object.entries(network.actions)) {
    for (const interaction of action.interactions) {
      interactions.push({ actionType, interaction });
    }
  }
  return interactions;
}
```

> If `getActionsForDomain`/`getActionsForTarget` (or anything else) still references `getAllInteractions`, do NOT delete it — instead leave it and note it; grep `getAllInteractions` first. (Current code only uses it in the `visibleDomains` block being replaced.)

- [ ] **Step 5: Hide the network selector when bound.** Replace (line ~742):

```ts
  const showNetworkSelector = allNetworks.length > 1;
```

with:

```ts
  const showNetworkSelector = !servedBinding && allNetworks.length > 1;
```

- [ ] **Step 6: Typecheck — expect exit 0.** `pnpm typecheck`. Backward-compat check: with no binding and no `?as=`, `viewerDomain` is `null` ⇒ `computeVisibleDomains(network, null)` returns all `to_domain`s (today's exact set), and `showNetworkSelector` is unchanged.

- [ ] **Step 7: Commit.**

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "feat(ui): scope Browse + network to the served binding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Profile creation — skip the picker when bound (`profile-form-page.tsx`)

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`

- [ ] **Step 1: Import the binding.** Add near the other `@/lib` imports:

```ts
import { getServedBinding } from '@/lib/served-binding';
```

- [ ] **Step 2: Resolve the binding once** (place near the top of the component body, before the network-resolution logic):

```ts
  const servedBinding = getServedBinding();
```

- [ ] **Step 3: Pin the target network to the binding.** Find where the target network id is resolved for create/edit (the `?network=` → `VITE_NETWORK_ID` → first-available resolution, around lines ~84-117). Make the binding win — at the start of that resolution prefer `servedBinding?.network`. Concretely, where the code computes the chosen network id (e.g. `const targetNetworkId = networkFromUrl ?? configuredNetworkIds[0] ?? ...`), change it to:

```ts
  const targetNetworkId = servedBinding?.network ?? /* existing expression unchanged */;
```

> Read the exact current expression first and wrap it with `servedBinding?.network ?? (...)`. Do not change its internals.

- [ ] **Step 4: Auto-select the bound domain so the picker is skipped.** Add this effect alongside the existing "Locked users skip the role picker" effect (after line ~254):

```ts
  // Served-binding UIs are scoped to one domain — skip the role picker entirely
  // and go straight to that domain's form (create mode only).
  React.useEffect(() => {
    if (isEdit || !servedBinding) return;
    if (selectedDomain !== servedBinding.domain) setSelectedDomain(servedBinding.domain);
  }, [isEdit, servedBinding, selectedDomain]);
```

This makes `selectedDomain` non-null on first render-after-mount, so the picker early-return (`if (!selectedDomain && !isEdit)`, line ~604) is never shown — the form for the bound domain renders directly.

- [ ] **Step 5: Typecheck — expect exit 0.** `pnpm typecheck`. Backward-compat: with no binding the new effect is a no-op (`!servedBinding` returns early), so the picker/lock behavior is unchanged.

- [ ] **Step 6: Commit.**

```bash
git add apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): bound UI goes straight to its domain's profile form (no picker)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Login domain gate (after OTP) + message

**Files:**
- Modify: `apps/ui/src/pages/auth/otp-page.tsx`
- Modify: `apps/ui/src/pages/auth/login-page.tsx`
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`

- [ ] **Step 1: Add the i18n string.** In `apps/ui/src/i18n/locales/en.json`, under the `auth` object, add:

```json
    "wrong_portal": "This account already has a profile in the {{domain}} domain. Please sign in through the {{domain}} portal."
```

Add the same key to `hi.json` and `kn.json` under their `auth` objects (English text is acceptable as a placeholder; flag for translation — react-i18next falls back to `en` regardless).

- [ ] **Step 2: Run the gate after OTP verify.** In `apps/ui/src/pages/auth/otp-page.tsx`:

Add imports:
```ts
import { getServedBinding } from '@/lib/served-binding';
import { evaluateDomainGate, resolveHeldDomains } from '@/lib/domain-gate';
```

Pull `signOut` from the auth hook (it currently destructures `{ verifyOtp }`):
```ts
  const { verifyOtp, signOut } = useAuth();
```

In `handleOtpComplete`, replace the post-verify navigate:
```ts
      await verifyOtp(getAuthIdentifier(state), otp, state.userExists ? undefined : state.name);
      toast.success(state.userExists ? t('auth.toast_welcome_back') : t('auth.toast_account_created'), {
        description: state.userExists
          ? t('auth.toast_welcome_back_desc')
          : t('auth.toast_account_created_desc'),
      });
      navigate(state.redirectTo ?? '/', { replace: true });
```
with:
```ts
      await verifyOtp(getAuthIdentifier(state), otp, state.userExists ? undefined : state.name);

      // Per-domain UI: block a user who already holds a profile in another
      // domain of this network (they must use that domain's portal).
      const binding = getServedBinding();
      if (binding) {
        const held = await resolveHeldDomains(binding.network);
        const gate = evaluateDomainGate(held, binding.domain);
        if (!gate.allow) {
          await signOut();
          navigate('/auth/login', { replace: true, state: { wrongPortalDomain: gate.heldDomain } });
          return;
        }
      }

      toast.success(state.userExists ? t('auth.toast_welcome_back') : t('auth.toast_account_created'), {
        description: state.userExists
          ? t('auth.toast_welcome_back_desc')
          : t('auth.toast_account_created_desc'),
      });
      navigate(state.redirectTo ?? '/', { replace: true });
```

- [ ] **Step 3: Show the message on the login page.** In `apps/ui/src/pages/auth/login-page.tsx`:

Add `useLocation` to the router import and read the redirect state:
```ts
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
```
Inside the component, after the existing hooks:
```ts
  const location = useLocation();

  React.useEffect(() => {
    const wrongPortalDomain = (location.state as { wrongPortalDomain?: string } | null)?.wrongPortalDomain;
    if (wrongPortalDomain) {
      toast.error(t('auth.wrong_portal', { domain: wrongPortalDomain }));
      // Clear the state so the toast doesn't re-fire on back/refresh.
      window.history.replaceState({}, '');
    }
  }, [location.state, t]);
```
(If `React` is not already imported in this file, add `import * as React from 'react';` — confirm; otherwise use the existing `useEffect` import. `toast` and `t` are already imported.)

- [ ] **Step 4: Typecheck — expect exit 0.** `pnpm typecheck`. Backward-compat: with no binding, `getServedBinding()` is null, the gate block is skipped entirely, and the OTP flow is byte-for-byte unchanged.

- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/pages/auth/otp-page.tsx apps/ui/src/pages/auth/login-page.tsx \
  apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): block cross-domain login after OTP on a bound UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck.** `pnpm typecheck` → exit 0.

- [ ] **Step 2: Run the UI test suite.** `pnpm --filter ui exec vitest run` → all pass (includes the three new pure-helper tests).

- [ ] **Step 3: Manual smoke (local, purple_dot).** With the API running on purple_dot and the signals UI served with a `config.js` (or `apps/ui/.env`) setting `VITE_SERVED_BINDING`:
  - `purple_dot/provider`: Browse shows seekers (+providers); no network selector; "create profile" opens the provider form directly (no role picker); a seeker account is blocked at login with the name-only message; a brand-new account proceeds and can create a provider profile.
  - `purple_dot/seeker`: Browse shows providers only; "create profile" opens the seeker form directly.
  - **Unset** `VITE_SERVED_BINDING`: the app is unchanged (multi-domain browse, picker, selector as today).

- [ ] **Step 4: Confirm no backend / build-pipeline change.** `git diff feature..HEAD --name-only` touches only `apps/ui/**` and the docs; no `apps/api/**`, no `vite.config.ts`, no `Dockerfile`.

---

## Self-Review

**Spec coverage:**
- Runtime `network/domain` knob → Task 1 (`served-binding`), consumed in Tasks 4–6. ✅
- Act-as + browse-targets → Task 4 (`currentDomain`/`viewerDomain` + `computeVisibleDomains`). ✅
- No picker page → Task 5 (auto-select bound domain → picker early-return skipped). ✅
- Login gate after OTP, name-only message, no backend change → Task 6 (`evaluateDomainGate`/`resolveHeldDomains`, message via nav state). ✅
- Hide network selector → Task 4 Step 5. ✅
- Backward-compatible when unset → every consumer guards on the binding / `null` viewerDomain; verified in Tasks 4–6 typecheck notes and Task 7 Step 3. ✅
- Theme network pinning at first paint (`index.html`) — **NOTE:** the spec's Component 5 mentions the pre-React `index.html` script reading the binding for first-paint theme. It is intentionally **not** required for functional correctness (the React `theme-provider` re-applies the network theme on mount, and the binding pins `selectedNetworkId`); the only effect of omitting it is a possible first-paint theme flash before React hydrates. Left out of these tasks to keep scope tight; if the flash is undesirable, add `VITE_SERVED_BINDING` (split on `/`) as the top-priority source in the `index.html` script and `theme-provider.tsx` as a small follow-up. Flagging rather than silently dropping.

**Placeholder scan:** No TBD/TODO. The two "read the exact current expression first" notes (Task 4 Step 4 grep guard; Task 5 Step 3 network expression) name the exact transformation; they are guardrails, not unspecified work.

**Type consistency:** `ServedBinding {network,domain}`, `getServedBinding()/parseServedBinding()`, `computeVisibleDomains(network, viewerDomain)`, `evaluateDomainGate(heldDomains, boundDomain)→DomainGate`, `resolveHeldDomains(networkId)`, nav state key `wrongPortalDomain`, i18n key `auth.wrong_portal` with `{{domain}}` — names are consistent across Tasks 1, 3, 4, 5, 6 and their tests.
