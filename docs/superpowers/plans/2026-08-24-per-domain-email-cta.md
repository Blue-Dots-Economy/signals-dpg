# Per-domain email CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every email link the API already emits resolve to the recipient's own portal host, instead of the single blocked combined front-door.

**Architecture:** The API receives the existing `ui.hostBindings` string verbatim as a new `UI_HOST_BINDINGS` env var and inverts it in TypeScript (`host=network/domain` becomes `domain -> origin`). The CTA URL moves out of the process-wide memoized notifier config into a per-recipient lookup keyed on the recipient's own domain. `FRONTEND_BASE_URL` stays as the fallback, so single-host installs are untouched.

**Tech Stack:** TypeScript (ESM, strict), Fastify, Zod, Vitest, pnpm/Turborepo. Infra: OpenTofu + Helm in `bluedots-automation`.

**Spec:** `docs/superpowers/specs/2026-08-24-per-domain-email-cta-design.md`

## Global Constraints

- **Branch:** `feat/569-per-domain-email-cta`, worktree `Signals-DPG.worktrees/569-email-cta`, based on `origin/feature`.
- **Do not change any email template or copy file.** Re-point links that already exist; never add a link to a mail that lacks one.
- **Node `>=24`, `pnpm@11.1.2`.** Files are snake_case; Zod schemas PascalCase; route handler exports snake_case.
- **ESM only, strict TS, no `any`.** Use `import type` for type-only imports.
- **No `// TODO` comments** — open an issue instead.
- **New env vars change two places together** (`.claude/rules/env-vars.md`): the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv`.
- **No `console.log` in library packages.** App code logs through `request.log` / `app.log`.
- **Never throws on config.** A malformed `UI_HOST_BINDINGS` entry is skipped with a warning; it must never fail boot.
- **Run tests with:** `pnpm --filter api exec vitest run <path>` and `pnpm --filter @dpg/config exec vitest run <path>`.
- **PR description must include an "In Plain Terms" section** (see root `CLAUDE.md`).

---

## Spec amendment adopted by this plan

The spec assumed host bindings always carry bare FQDNs, so the resolver would hardcode `https://`. Standing up the local split-UI stack (Task 8) makes that unusable locally, where portals are `http://localhost:5174`.

**Resolution:** the host part of an entry MAY carry an explicit `http://` or `https://` scheme (and a port). When it does, it is used verbatim; when it does not, `https://` is prepended. Production strings are unchanged (bare FQDN → `https://`), and local dev writes `http://localhost:5174=blue_dot/seeker`. This is additive and backward compatible.

---

## File Structure

**`packages/config/src/ui_host_bindings.ts`** (new) — pure parsing of the `UI_HOST_BINDINGS` env string into a `domain -> origin` map plus warnings. Lives here, beside `parseServedDomains`, because that is where this repo already turns env strings into structured config. Imports nothing from `apps/`.

**`packages/config/src/index.ts`** (modify) — barrel export.

**`packages/config/src/secrets.ts`** (modify) — the `UI_HOST_BINDINGS` field on `NotificationSecretsSchema`.

**`turbo.json`** (modify) — `globalPassThroughEnv` entry.

**`apps/api/src/config.ts`** (modify) — parse once at module load, export the result.

**`apps/api/src/app.ts`** (modify) — emit the parse warnings and the unknown-domain cross-check once a logger exists.

**`apps/api/src/notifications/brand.ts`** (modify) — `createCtaUrlResolver`, beside the existing `buildCtaUrl`. This file is already "Brand / URL resolution for action emails. Pure helpers", which is exactly this.

**`apps/api/src/notifications/notify_actions.ts`** (modify) — build the resolver, put it on `NotifierConfig`, fix the config gate.

**`apps/api/src/notifications/dispatcher.ts`** (modify) — per-recipient CTA lookup.

**`apps/api/src/notifications/notify_retire.ts`** (modify) — per-counterparty CTA lookup.

**`apps/api/src/notifications/welcome.ts`** (modify) — optional `domain`, resolved `siteUrl`.

**`apps/api/src/services/auth/provisioning.ts`** (modify) — return the applied signup domain and pass it to the welcome call.

**`bluedots-automation`** — `opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl` (one line) and `helm/README.md` (one row).

---

## Task 1: Parse `UI_HOST_BINDINGS` into a domain → origin map

**Files:**
- Create: `packages/config/src/ui_host_bindings.ts`
- Create: `packages/config/src/__tests__/ui_host_bindings.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ParsedUiHostBindings { byDomain: Record<string, string>; warnings: string[] }`
  - `function parseUiHostBindings(raw: string | undefined): ParsedUiHostBindings`
  - `function unknownBindingDomains(byDomain: Record<string, string>, knownDomains: readonly string[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/config/src/__tests__/ui_host_bindings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseUiHostBindings, unknownBindingDomains } from '../ui_host_bindings';

describe('parseUiHostBindings', () => {
  it('inverts a multi-entry host binding string into domain -> origin', () => {
    const result = parseUiHostBindings(
      'bluedotssignals.provider.org=purple_dot/provider;bluedotssignals.seeker.org=purple_dot/seeker'
    );
    expect(result.byDomain).toEqual({
      provider: 'https://bluedotssignals.provider.org',
      seeker: 'https://bluedotssignals.seeker.org',
    });
    expect(result.warnings).toEqual([]);
  });

  it('returns an empty map for empty or undefined input', () => {
    expect(parseUiHostBindings('').byDomain).toEqual({});
    expect(parseUiHostBindings(undefined).byDomain).toEqual({});
    expect(parseUiHostBindings('').warnings).toEqual([]);
  });

  it('strips a single layer of Helm quote wrapping', () => {
    const result = parseUiHostBindings('"a.example.org=blue_dot/seeker"');
    expect(result.byDomain).toEqual({ seeker: 'https://a.example.org' });
  });

  it('honours an explicit http(s) scheme and port on the host', () => {
    const result = parseUiHostBindings(
      'http://localhost:5174=blue_dot/seeker;https://p.example.org:8443=blue_dot/provider'
    );
    expect(result.byDomain).toEqual({
      seeker: 'http://localhost:5174',
      provider: 'https://p.example.org:8443',
    });
    expect(result.warnings).toEqual([]);
  });

  it('skips an entry with no "=" separator and warns', () => {
    const result = parseUiHostBindings('justtext;a.example.org=blue_dot/seeker');
    expect(result.byDomain).toEqual({ seeker: 'https://a.example.org' });
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: skipping entry with no "=" separator: "justtext"',
    ]);
  });

  it('skips an entry whose binding is not "network/domain" and warns', () => {
    const result = parseUiHostBindings('a.example.org=seeker');
    expect(result.byDomain).toEqual({});
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: skipping entry with invalid "network/domain" binding: "a.example.org=seeker"',
    ]);
  });

  it('skips an entry with an empty host and warns', () => {
    const result = parseUiHostBindings('=blue_dot/seeker');
    expect(result.byDomain).toEqual({});
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: skipping entry with an empty host: "=blue_dot/seeker"',
    ]);
  });

  it('keeps the FIRST host on a duplicate domain and warns', () => {
    const result = parseUiHostBindings(
      'canonical.example.org=blue_dot/seeker;vanity.example.org=blue_dot/seeker'
    );
    expect(result.byDomain).toEqual({ seeker: 'https://canonical.example.org' });
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: duplicate entry for domain "seeker" — the first one wins',
    ]);
  });

  it('accepts newline separators alongside semicolons', () => {
    const result = parseUiHostBindings('a.example.org=blue_dot/seeker\nb.example.org=blue_dot/provider');
    expect(Object.keys(result.byDomain).sort()).toEqual(['provider', 'seeker']);
  });
});

describe('unknownBindingDomains', () => {
  it('names keys that the served-domain list does not declare', () => {
    expect(unknownBindingDomains({ seekr: 'https://a', seeker: 'https://b' }, ['seeker', 'provider']))
      .toEqual(['seekr']);
  });

  it('returns an empty list when every key is known', () => {
    expect(unknownBindingDomains({ seeker: 'https://b' }, ['seeker', 'provider'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/ui_host_bindings.test.ts`
Expected: FAIL — cannot resolve `../ui_host_bindings`.

- [ ] **Step 3: Write the implementation**

Create `packages/config/src/ui_host_bindings.ts`:

```ts
/**
 * Inverts the deployment's host-binding string into the map the API needs to
 * send a recipient to their OWN portal.
 *
 * The same string drives the UI ingress in the other direction — it derives
 * `VITE_SERVED_BINDINGS` (host -> network/domain) from the request's Host
 * header. Here we derive domain -> origin. One value, two directions, so the
 * two cannot drift into disagreeing about which host serves which domain.
 *
 * Format (identical to `ui.hostBindings`):
 *   host=network/domain;host=network/domain
 *
 * The host MAY carry an explicit `http://` / `https://` scheme and a port, in
 * which case it is used verbatim; a bare hostname gets `https://`. Deployed
 * strings are bare FQDNs; the scheme form exists so a local split-UI stack can
 * point at `http://localhost:5174`.
 *
 * Never throws. One typo must not take the API down over an optional feature,
 * so a malformed entry is dropped with a warning. Warnings are RETURNED rather
 * than logged because this runs at module load, before a logger exists — the
 * caller logs them once Fastify is up.
 */

const BINDING_REGEX = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

export interface ParsedUiHostBindings {
  /** Item domain (e.g. "seeker") -> portal origin (e.g. "https://x.org"). */
  byDomain: Record<string, string>;
  /** One message per skipped or ambiguous entry. */
  warnings: string[];
}

/**
 * Strips a single layer of Helm `| quote`-style wrapping plus surrounding
 * whitespace. A ConfigMap value round-tripped through `| quote` arrives with
 * the quotes still attached.
 */
function stripHelmQuoting(raw: string): string {
  const v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** Normalize the host half of an entry into an origin, or null if unusable. */
function toOrigin(host: string): string | null {
  if (!host) return null;
  if (/^https?:\/\//.test(host)) {
    try {
      return new URL(host).origin;
    } catch {
      return null;
    }
  }
  // A bare hostname must not carry a path or whitespace.
  if (host.includes('/') || /\s/.test(host)) return null;
  return `https://${host}`;
}

export function parseUiHostBindings(raw: string | undefined): ParsedUiHostBindings {
  const byDomain: Record<string, string> = {};
  const warnings: string[] = [];

  for (const rawEntry of stripHelmQuoting(raw ?? '').split(/[;\n]/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    // First `=` only: the host half may itself be a URL containing `=`.
    const eq = entry.indexOf('=');
    if (eq === -1) {
      warnings.push(`UI_HOST_BINDINGS: skipping entry with no "=" separator: "${entry}"`);
      continue;
    }

    const host = entry.slice(0, eq).trim();
    const binding = entry.slice(eq + 1).trim();

    const origin = toOrigin(host);
    if (!origin) {
      warnings.push(`UI_HOST_BINDINGS: skipping entry with an empty host: "${entry}"`);
      continue;
    }
    if (!BINDING_REGEX.test(binding)) {
      warnings.push(
        `UI_HOST_BINDINGS: skipping entry with invalid "network/domain" binding: "${entry}"`
      );
      continue;
    }

    const domain = binding.split('/')[1];
    if (Object.hasOwn(byDomain, domain)) {
      // FIRST wins, not last: a vanity alias listed after the canonical host
      // must not silently displace it.
      warnings.push(
        `UI_HOST_BINDINGS: duplicate entry for domain "${domain}" — the first one wins`
      );
      continue;
    }
    byDomain[domain] = origin;
  }

  return { byDomain, warnings };
}

/**
 * Which parsed keys name no domain this instance serves.
 *
 * Log-only by design. Filtering unknown keys would be wrong: a domain added to
 * `network.json` ahead of the ConfigMap rollout (or vice versa) must not be
 * able to switch a working link off.
 */
export function unknownBindingDomains(
  byDomain: Record<string, string>,
  knownDomains: readonly string[]
): string[] {
  const known = new Set(knownDomains);
  return Object.keys(byDomain).filter((domain) => !known.has(domain));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/ui_host_bindings.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Export from the barrel**

Add to `packages/config/src/index.ts`, keeping the list alphabetical:

```ts
export * from './ui_host_bindings';
```

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/ui_host_bindings.ts packages/config/src/__tests__/ui_host_bindings.test.ts packages/config/src/index.ts
git commit -m "feat(config): parse UI_HOST_BINDINGS into a domain -> origin map (#569)"
```

---

## Task 2: Wire the env var and emit boot warnings

**Files:**
- Modify: `packages/config/src/secrets.ts:262` (the `NotificationSecretsSchema` block)
- Modify: `turbo.json:25` (`globalPassThroughEnv`, alphabetical)
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/app.ts:104` (inside `buildApp`, after the logger exists)

**Interfaces:**
- Consumes: `parseUiHostBindings`, `unknownBindingDomains` (Task 1).
- Produces: `uiHostBindings: ParsedUiHostBindings` exported from `apps/api/src/config.ts`.

- [ ] **Step 1: Add the env field**

In `packages/config/src/secrets.ts`, immediately after the `FRONTEND_BASE_URL` field:

```ts
  // Host -> "network/domain" map for this deployment, IDENTICAL to the string
  // the UI ingress uses to derive VITE_SERVED_BINDINGS. Inverted at boot so an
  // email CTA can point the recipient at their own portal rather than at the
  // single FRONTEND_BASE_URL front-door, which is the combined front-door on a
  // split deployment (#569). Empty = single-host install; FRONTEND_BASE_URL is
  // then the only source and behaviour is unchanged.
  UI_HOST_BINDINGS: z.string().default(''),
```

- [ ] **Step 2: Add the turbo passthrough**

In `turbo.json`, in `globalPassThroughEnv`, alphabetically (after `SUPPORT_EMAIL`-ish entries — find the correct slot for `UI_HOST_BINDINGS`):

```json
    "UI_HOST_BINDINGS",
```

This is mandatory, not optional: without it the var reaches a bare `vite`/`node` run but not a turbo-filtered task. See `.claude/rules/env-vars.md`.

- [ ] **Step 3: Parse once in the API config**

In `apps/api/src/config.ts`, add `parseUiHostBindings` to the existing `@dpg/config` import, then add this export after `apiConfig`:

```ts
/**
 * Inverted host bindings (domain -> portal origin), parsed once at boot. The
 * warnings are logged by `buildApp`, which is the first point a logger exists.
 */
export const uiHostBindings = parseUiHostBindings(notification.UI_HOST_BINDINGS);
```

- [ ] **Step 4: Log the warnings at boot**

In `apps/api/src/app.ts`, inside `buildApp` right after `registerRequestIdEcho(app);`:

```ts
  // UI_HOST_BINDINGS is parsed at module load, before a logger exists (#569),
  // so its warnings surface here. Malformed entries were already dropped; this
  // is the only signal an operator gets that a portal link is misconfigured.
  for (const warning of uiHostBindings.warnings) {
    app.log.warn(warning);
  }
  const unknown = unknownBindingDomains(
    uiHostBindings.byDomain,
    apiConfig.served_domains.map((b) => b.domain)
  );
  if (unknown.length > 0) {
    app.log.warn(
      { domains: unknown },
      'UI_HOST_BINDINGS names domains this instance does not serve — their emails will fall back to FRONTEND_BASE_URL'
    );
  }
```

Add the imports: `unknownBindingDomains` from `@dpg/config`, and `uiHostBindings` alongside the existing `apiConfig` import from `@/config`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/secrets.ts turbo.json apps/api/src/config.ts apps/api/src/app.ts
git commit -m "feat(api): read UI_HOST_BINDINGS and warn on bad entries at boot (#569)"
```

---

## Task 3: Per-domain CTA resolver

**Files:**
- Modify: `apps/api/src/notifications/brand.ts`
- Modify: `apps/api/src/notifications/__tests__/brand.test.ts`

**Interfaces:**
- Consumes: `ParsedUiHostBindings['byDomain']` (Task 1), `buildCtaUrl` (existing, `brand.ts:8`).
- Produces: `function createCtaUrlResolver(opts: { byDomain: Record<string, string>; fallbackBaseUrl?: string }): (domain: string) => string | undefined`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/notifications/__tests__/brand.test.ts`:

```ts
import { createCtaUrlResolver } from '../brand';

describe('createCtaUrlResolver', () => {
  const byDomain = {
    seeker: 'https://seeker.example.org',
    provider: 'https://provider.example.org',
  };

  it('resolves each domain to its own portal login URL', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('seeker')).toBe('https://seeker.example.org/auth/login');
    expect(resolve('provider')).toBe('https://provider.example.org/auth/login');
  });

  it('falls back to FRONTEND_BASE_URL for an unmapped domain', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('unmapped')).toBe('https://old.example.org/auth/login');
  });

  it('uses the fallback for every domain when the map is empty (single-host install)', () => {
    const resolve = createCtaUrlResolver({ byDomain: {}, fallbackBaseUrl: 'https://old.example.org/' });
    expect(resolve('seeker')).toBe('https://old.example.org/auth/login');
  });

  it('returns undefined when neither the map nor the fallback has an answer', () => {
    const resolve = createCtaUrlResolver({ byDomain: {} });
    expect(resolve('seeker')).toBeUndefined();
  });

  it('prefers the map over the fallback even when both could answer', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('seeker')).not.toContain('old.example.org');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/__tests__/brand.test.ts`
Expected: FAIL — `createCtaUrlResolver` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/notifications/brand.ts`:

```ts
/**
 * Builds the per-recipient CTA resolver.
 *
 * Which portal a mail should link to depends on the RECIPIENT's own domain —
 * the seeker's "your application was sent" mail belongs on the seeker portal
 * and the provider's "a seeker applied" mail on the provider portal — so this
 * cannot be resolved once per process the way it used to be (#569).
 *
 * Falls back to the single `FRONTEND_BASE_URL` front-door on a miss. On a split
 * deployment that host is blocked, so the fallback is a link that does not
 * work; it is kept anyway because the alternative for a CTA-shell mail is
 * sending no email at all or changing the template. The boot-time
 * unknown-domain warning is what tells an operator a mapping is missing.
 *
 * @param byDomain - Inverted host bindings; `{}` on a single-host install.
 * @param fallbackBaseUrl - `FRONTEND_BASE_URL`, when set.
 * @returns A resolver returning the login URL, or undefined when nothing is configured.
 */
export function createCtaUrlResolver(opts: {
  byDomain: Record<string, string>;
  fallbackBaseUrl?: string;
}): (domain: string) => string | undefined {
  const { byDomain, fallbackBaseUrl } = opts;
  return (domain: string) => {
    const origin = byDomain[domain] ?? fallbackBaseUrl;
    return origin ? buildCtaUrl(origin) : undefined;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/__tests__/brand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/brand.ts apps/api/src/notifications/__tests__/brand.test.ts
git commit -m "feat(api): add a per-recipient CTA URL resolver (#569)"
```

---

## Task 4: Resolve the action-email CTA per recipient

**Files:**
- Modify: `apps/api/src/notifications/dispatcher.ts:23` and `:72`
- Modify: `apps/api/src/notifications/notify_actions.ts:18`, `:48-72`, `:104`
- Modify: `apps/api/src/notifications/__tests__/dispatcher.test.ts`

**Interfaces:**
- Consumes: `createCtaUrlResolver` (Task 3), `uiHostBindings` (Task 2).
- Produces: `DispatcherDeps.resolveCtaUrl: (domain: string) => string | undefined`; `NotifierConfig.resolveCtaUrl` with the same signature. `NotifierConfig.ctaUrl` is REMOVED.

**Note:** `NotificationPlan` is deliberately NOT changed. Keying on domain alone makes the issue's proposed `recipientNetwork` field unnecessary.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/notifications/__tests__/dispatcher.test.ts`, replace the `brand` block inside `makeDeps` with:

```ts
    brand: {
      brandName: 'Blue Dot',
    },
    resolveCtaUrl: (domain: string) =>
      domain === 'seeker'
        ? 'https://seeker.example.org/auth/login'
        : 'https://provider.example.org/auth/login',
```

Then append this test:

```ts
  it('sends each side to its OWN portal, not the counterparty portal', async () => {
    const { deps, calls } = makeDeps();
    // source = seeker, target = provider (see createEvent).
    await createDirectDispatcher(deps).dispatch(createEvent());

    const inbound = calls.find((c) => c.dedupeId?.endsWith('INBOUND_REQUEST'));
    const outbound = calls.find((c) => c.dedupeId?.endsWith('OUTBOUND_REQUEST'));

    // INBOUND_REQUEST goes to the TARGET (provider) → provider portal.
    expect(inbound?.ctaUrl).toBe('https://provider.example.org/auth/login');
    // OUTBOUND_REQUEST goes to the SOURCE (seeker) → seeker portal.
    expect(outbound?.ctaUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('skips a recipient whose domain resolves to no URL rather than sending a dead link', async () => {
    // Reachable once the gate accepts a map-only config: UI_HOST_BINDINGS is
    // set (so the gate passes) but FRONTEND_BASE_URL is not, and this
    // recipient's domain is absent from the map. `dispatch_email` would render
    // `ctaUrl: args.ctaUrl ?? ''` into `<a href="">` — an email whose only
    // call to action is a broken button.
    const { deps, calls, skips } = makeDeps({
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker' ? 'https://seeker.example.org/auth/login' : undefined,
    });

    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctaUrl).toBe('https://seeker.example.org/auth/login');
    expect(skips).toContain('no_cta_url');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/__tests__/dispatcher.test.ts`
Expected: FAIL — TS error on the unknown `resolveCtaUrl` property, and the new assertions fail.

- [ ] **Step 3: Change the dispatcher**

In `apps/api/src/notifications/dispatcher.ts`, change the `brand` member of `DispatcherDeps` and add the resolver:

```ts
  brand: {
    brandName: string;
  };
  /**
   * The login URL for a recipient in `domain`. Per-recipient, not per-process:
   * on a split deployment each domain has its own portal host (#569).
   */
  resolveCtaUrl: (domain: string) => string | undefined;
```

And in `dispatchPlan`, replace `ctaUrl: deps.brand.ctaUrl,` with:

```ts
      // The RECIPIENT's own domain, never the counterparty's — keying off
      // `counterpartyDomain` here would send each party to the other's portal.
      ctaUrl: deps.resolveCtaUrl(plan.recipientDomain),
```

- [ ] **Step 4: Guard against a dead `href=""`**

Still in `dispatchPlan`, resolve the URL BEFORE calling `sendEmail` and bail when there is none:

```ts
    // `dispatch_email` renders `args.ctaUrl ?? ''` into the shell, so an
    // unresolved URL ships an `<a href="">` whose button does nothing. That is
    // now reachable: the gate below accepts a map-only config, so a domain
    // missing from UI_HOST_BINDINGS with no FRONTEND_BASE_URL set has no
    // answer. Send nothing rather than a mail whose only CTA is broken — the
    // boot-time unknown-domain warning is the operator-facing signal.
    const ctaUrl = deps.resolveCtaUrl(plan.recipientDomain);
    if (!ctaUrl) {
      deps.onSkip('no_cta_url');
      deps.log('notification skipped: no CTA url for recipient domain', {
        shape: plan.shape,
        actionId: plan.actionId,
        domain: plan.recipientDomain,
      });
      return;
    }
```

and pass `ctaUrl` (the local) in the `sendEmail` call rather than calling the resolver inline.

- [ ] **Step 5: Change the notifier config**

In `apps/api/src/notifications/notify_actions.ts`, change the `NotifierConfig` interface:

```ts
export interface NotifierConfig {
  sender: EmailSender;
  resolveCtaUrl: (domain: string) => string | undefined;
}
```

Replace the gate and the `ctaUrl` construction inside `resolveNotifierConfig`:

```ts
  const nc = getNotificationClient();
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL;
  const frontendBaseUrl = notification.FRONTEND_BASE_URL;
  const hasAnyUrl =
    !!frontendBaseUrl || Object.keys(uiHostBindings.byDomain).length > 0;

  // Gate on "some URL source exists", not on the scalar alone: a split
  // deployment configures UI_HOST_BINDINGS and may leave FRONTEND_BASE_URL
  // unset, and requiring the scalar would silently stop EVERY action email
  // rather than degrade one link (#569).
  if (!nc || !fromEmail || !hasAnyUrl) {
    cachedConfig = null;
    return cachedConfig;
  }
```

and replace `ctaUrl: buildCtaUrl(frontendBaseUrl),` with:

```ts
    resolveCtaUrl: createCtaUrlResolver({
      byDomain: uiHostBindings.byDomain,
      fallbackBaseUrl: frontendBaseUrl,
    }),
```

Update the imports: `import { createCtaUrlResolver, resolveBrandName } from './brand';` (drop `buildCtaUrl`, which is now only used inside `brand.ts`), and add `uiHostBindings` to the existing `@/config` import.

Finally, in `dispatchActionNotifications`, replace `brand: { brandName, ctaUrl: config.ctaUrl },` with:

```ts
    brand: { brandName },
    resolveCtaUrl: config.resolveCtaUrl,
```

Also update the doc comment on `resolveNotifierConfig` — it currently says action emails "stay gated on an explicit NOTIFICATION_FROM_EMAIL + FRONTEND_BASE_URL". Change that clause to "NOTIFICATION_FROM_EMAIL plus at least one URL source (UI_HOST_BINDINGS or FRONTEND_BASE_URL)".

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/notifications/`
Expected: PASS. `notify_retire.test.ts` may now fail to compile — that is Task 5; if so, do Task 5 before committing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/notifications/dispatcher.ts apps/api/src/notifications/notify_actions.ts apps/api/src/notifications/__tests__/dispatcher.test.ts
git commit -m "feat(api): resolve the action-email CTA from the recipient's own domain (#569)"
```

---

## Task 5: Resolve the retire-email CTA per counterparty

**Files:**
- Modify: `apps/api/src/notifications/notify_retire.ts:52`
- Modify: `apps/api/src/notifications/__tests__/notify_retire.test.ts`

**Interfaces:**
- Consumes: `NotifierConfig.resolveCtaUrl` (Task 4). `RetireCancelledCounterparty.domain` already exists (`services/items/retire_connections.ts:22`) — no new plumbing.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/notifications/__tests__/notify_retire.test.ts` (match the file's existing mocking style for `resolveNotifierConfig`; the assertion is what matters):

```ts
  it('sends each cancelled counterparty to its own portal', async () => {
    // Two counterparties in different domains on one retire.
    const counterparties = [
      { actionId: 'a1', actionType: 'connect', ownerUserId: 'u1', itemId: 'i1', domain: 'seeker', network: 'blue_dot' },
      { actionId: 'a2', actionType: 'connect', ownerUserId: 'u2', itemId: 'i2', domain: 'provider', network: 'blue_dot' },
    ];

    await dispatchRetireCancelNotifications(counterparties, 'blue_dot', log);

    const seeker = sent.find((s) => s.dedupeId?.includes('u1'));
    const provider = sent.find((s) => s.dedupeId?.includes('u2'));
    expect(seeker?.ctaUrl).toBe('https://seeker.example.org/auth/login');
    expect(provider?.ctaUrl).toBe('https://provider.example.org/auth/login');
  });
```

The mocked `resolveNotifierConfig` must now return `resolveCtaUrl` instead of `ctaUrl`:

```ts
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker'
          ? 'https://seeker.example.org/auth/login'
          : 'https://provider.example.org/auth/login',
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/__tests__/notify_retire.test.ts`
Expected: FAIL — `config.ctaUrl` is undefined / TS error.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/notifications/notify_retire.ts`, replace `ctaUrl: config.ctaUrl,` with:

```ts
        // The counterparty's own domain — this mail goes to THEM, so it links
        // to their portal, not the retiring owner's (#569).
        ctaUrl: config.resolveCtaUrl(cp.domain),
```

Guard the same dead-`href` case as the dispatcher — add above the `dispatchEmail` call, after the email lookup:

```ts
      const ctaUrl = config.resolveCtaUrl(cp.domain);
      if (!ctaUrl) {
        log.warn(
          { actionId: cp.actionId, domain: cp.domain },
          'retire notification skipped: no CTA url for counterparty domain',
        );
        continue;
      }
```

and pass the local `ctaUrl`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/notify_retire.ts apps/api/src/notifications/__tests__/notify_retire.test.ts
git commit -m "feat(api): resolve the retire-email CTA from the counterparty's domain (#569)"
```

---

## Task 6: Resolve the welcome-email link from the signup domain

**Files:**
- Modify: `apps/api/src/notifications/welcome.ts:65-95`
- Modify: `apps/api/src/services/auth/provisioning.ts:443`, `:467-474`, `:548-573`
- Modify: `apps/api/src/notifications/__tests__/welcome.test.ts`

**Interfaces:**
- Consumes: `createCtaUrlResolver` (Task 3), `uiHostBindings` (Task 2).
- Produces:
  - `sendWelcomeNotifications(recipient: WelcomeRecipient, log: WelcomeLog, domain?: string | null): Promise<void>` — third parameter is new and optional, so the better-auth call site at `create_auth.ts:96` keeps compiling unchanged.
  - `applySignupExtras(...): Promise<string | null>` — now returns the applied domain instead of `void`.

**Scope reminder:** do NOT touch any `.properties` file. `welcome.body` already renders `{{siteLink}}` for `blue_dot` and `purple_dot`; only the value behind it changes.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/notifications/__tests__/welcome.test.ts` (follow the file's existing mock setup for the sender):

```ts
  it('links the welcome mail to the signup domain portal', async () => {
    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.com', phoneNumber: null },
      log,
      'seeker'
    );
    expect(dispatched[0]?.variables?.siteUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('omits siteUrl entirely when the domain resolves to nothing', async () => {
    // No mapping and no FRONTEND_BASE_URL: renderSiteLink(undefined) must be
    // able to fall back to the words "the platform" rather than a dead anchor.
    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.com', phoneNumber: null },
      log,
      'nosuchdomain'
    );
    expect(dispatched[0]?.variables).not.toHaveProperty('siteUrl');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/__tests__/welcome.test.ts`
Expected: FAIL — `sendWelcomeNotifications` takes two arguments.

- [ ] **Step 3: Change `welcome.ts`**

Change the signature and the `siteUrl` variable. Replace the `siteUrl` spread inside `variables` with a resolved value computed above the `dispatchEmail` call:

```ts
export async function sendWelcomeNotifications(
  recipient: WelcomeRecipient,
  log: WelcomeLog,
  /**
   * The domain this account signed up into, when known. Drives which portal the
   * welcome link points at on a split deployment (#569). Undefined for an
   * account with no parked signup domain (migrated or admin-onboarded), which
   * falls back to FRONTEND_BASE_URL and then to no link at all.
   */
  domain?: string | null
): Promise<void> {
```

and inside the email branch:

```ts
      const siteUrl = domain
        ? createCtaUrlResolver({
            byDomain: uiHostBindings.byDomain,
            fallbackBaseUrl: notification.FRONTEND_BASE_URL,
          })(domain)
        : notification.FRONTEND_BASE_URL;
```

then in `variables`, replace the old spread with:

```ts
          // Injected ONLY when resolvable: an empty value renders an invisible
          // dead link, while omitting it lets renderSiteLink fall back to the
          // words "the platform".
          ...(siteUrl ? { siteUrl } : {}),
```

Add the imports: `createCtaUrlResolver` from `./brand`, and `uiHostBindings` to the existing `@/config` import.

- [ ] **Step 4: Return the domain from `applySignupExtras`**

In `apps/api/src/services/auth/provisioning.ts`, change the signature to `Promise<string | null>`, return `extras.domain ?? null` on the success path, and `null` from every early return and from the `catch`. Then change the call site at line 443 and the welcome call:

```ts
  // Captures the domain this account signed up into so the welcome mail can
  // link to that portal (#569); previously this value was applied and dropped.
  const signupDomain = await applySignupExtras(user.id, identity, log);
```

```ts
    await sendWelcomeNotifications(
      {
        name: user.name,
        email: identity.email,
        phoneNumber: identity.phoneNumber,
      },
      log,
      signupDomain
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/notifications/ src/services/auth/`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/notifications/welcome.ts apps/api/src/services/auth/provisioning.ts apps/api/src/notifications/__tests__/welcome.test.ts
git commit -m "feat(api): link the welcome mail to the signup domain's portal (#569)"
```

---

## Task 7: Ship the value from infra

**Files:**
- Modify (in `bluedots-automation`): `opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl:48`
- Modify (in `bluedots-automation`): `helm/README.md:93`

**Interfaces:**
- Consumes: `UI_HOST_BINDINGS` (Task 2).
- Produces: nothing consumed by later tasks.

**Why there is no chart change:** the api subchart's ConfigMap is a generic passthrough (`helm/signals/charts/api/templates/configmap.yaml:8-9`, `range $key, $val := .Values.config` with an `if ne ($val | toString) ""` skip) and the deployment already does `envFrom: configMapRef` (`deployment.yaml:50-52`). And `signals_host_bindings` is already in the `templatefile(...)` map (`modules/output-file/main.tf:50`), so no new tofu variable is needed.

- [ ] **Step 1: Emit the value**

In `global-cloud-values.yaml.tfpl`, under `api: config:`, directly after the `FRONTEND_BASE_URL` line:

```yaml
    # Same string as ui.hostBindings below — the UI maps host -> domain, the API
    # maps domain -> host so an email CTA reaches the recipient's own portal
    # (#569). Emitted unconditionally: the api chart drops empty values, so a
    # single-host release (bindings == "") falls back to FRONTEND_BASE_URL.
    UI_HOST_BINDINGS: "${signals_host_bindings}"
```

- [ ] **Step 2: Verify the rendered output both ways**

Run, from the `bluedots-automation` repo root:

```bash
grep -n "UI_HOST_BINDINGS\|hostBindings" opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl
```

Expected: `UI_HOST_BINDINGS` appears once under `api.config` and `hostBindings` once under the conditional `ui:` block, both interpolating `${signals_host_bindings}`.

Confirm by inspection that the api-chart ConfigMap drops the key when the value is `""` — `charts/api/templates/configmap.yaml:9` is `{{- if ne ($val | toString) "" }}`.

- [ ] **Step 3: Document it**

In `helm/README.md`, change the `_signals_host_bindings` row of the anchor table to name both destinations:

```markdown
| `_signals_host_bindings` | multi-domain host→network/domain routing | `ui.hostBindings` **and** `api.config.UI_HOST_BINDINGS` (via `global-cloud-values.yaml`) |
```

- [ ] **Step 4: Commit (in `bluedots-automation`)**

```bash
git add opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl helm/README.md
git commit -m "feat(signals): pass the host bindings to the API as UI_HOST_BINDINGS (#569)"
```

---

## Task 8: Stand up a local split-UI stack for end-to-end testing

**Goal:** one API plus **two** UIs on separate origins — one per domain, as in production — so the recipient of an action email can confirm the link lands on their own portal.

**Files:**
- Create: `docs/operations/local-split-ui.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a documented, repeatable local setup.

**Why two Vite servers rather than one:** `VITE_SERVED_BINDINGS` is read per UI process, so a split portal is genuinely two processes. `apps/ui/vite.config.ts:317` already reads `VITE_UI_PORT` (default 5173), so this needs no code change.

- [ ] **Step 1: Configure the API**

In the worktree root `.env`:

```bash
SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"
NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/blue_dot/network.json"
ALLOWED_ORIGINS="http://localhost:5174,http://localhost:5175"
UI_HOST_BINDINGS="http://localhost:5174=blue_dot/seeker;http://localhost:5175=blue_dot/provider"
FRONTEND_BASE_URL="http://localhost:9999"
```

`FRONTEND_BASE_URL` is deliberately set to a port nothing listens on: it stands in for the blocked combined front-door, so a link that still points there is unmistakably a bug rather than a coincidence that happens to work.

The API must serve BOTH domains (`SERVED_DOMAINS` = all of them) even though each UI serves one — restricting the API's own list breaks single-instance browse (peer HTTP call to itself, `401 PEER_AUTH_FAILED` / `403 UNSERVED_DOMAIN_BINDING`).

- [ ] **Step 2: Start infra and the API**

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG.worktrees/569-email-cta
source ~/.nvm/nvm.sh && nvm use 24
docker compose up -d db redis
docker exec -i dpg-db psql -U postgres -d postgresdb -v ON_ERROR_STOP=0 < apps/api/db/postgres/schema.sql
find /var/folders /private/var/folders /tmp -maxdepth 5 -type d -name 'dpg-network-schema-cache' -exec rm -rf {} + 2>/dev/null
( cd apps/api && nohup node --env-file=../../.env --import tsx src/server.ts > /tmp/signals-api.log 2>&1 & )
```

- [ ] **Step 3: Verify the bindings parsed**

```bash
grep -i "UI_HOST_BINDINGS" /tmp/signals-api.log
```

Expected: **no output**. Any line here is a warning about a skipped entry and means the value is malformed.

- [ ] **Step 4: Start the two UIs**

Run each in its own background process, bypassing the turbo wrapper so the per-UI env is not overridden by root `.env`:

```bash
cd apps/ui
VITE_UI_PORT=5174 VITE_NETWORK_ID=blue_dot VITE_SERVED_BINDINGS=blue_dot/seeker \
  VITE_DEFAULT_NETWORK_THEME=blue_dot VITE_API_URL=http://localhost:2742 \
  nohup npx vite > /tmp/signals-ui-seeker.log 2>&1 &

VITE_UI_PORT=5175 VITE_NETWORK_ID=blue_dot VITE_SERVED_BINDINGS=blue_dot/provider \
  VITE_DEFAULT_NETWORK_THEME=blue_dot VITE_API_URL=http://localhost:2742 \
  nohup npx vite > /tmp/signals-ui-provider.log 2>&1 &
```

- [ ] **Step 5: Verify the split**

```bash
curl -s -o /dev/null -w 'seeker:   %{http_code}\n' http://localhost:5174/
curl -s -o /dev/null -w 'provider: %{http_code}\n' http://localhost:5175/
```

Expected: `200` from both. Then confirm in a browser that :5174's signup form auto-selects **seeker** with no domain picker, and :5175 auto-selects **provider** — that is the same `VITE_SERVED_BINDINGS` signal the mail fix keys off, so if the picker still appears the split is not in effect.

- [ ] **Step 6: Configure mail delivery**

Action emails need a notification client plus a from-address, or `resolveNotifierConfig` returns null and nothing sends:

```bash
NOTIFICATION_SERVICE_ENDPOINT=...
NOTIFICATION_SERVICE_KEY_ID=...
NOTIFICATION_SERVICE_SECRET=...
NOTIFICATION_FROM_EMAIL=...
```

Confirm the API sees them:

```bash
grep -i "notification" /tmp/signals-api.log | head
```

Use yopmail addresses for both test accounts so the mail is inspectable.

- [ ] **Step 7: Write the runbook**

Create `docs/operations/local-split-ui.md` capturing Steps 1-6 verbatim, plus the manual test matrix below. This is the deliverable that makes the setup repeatable rather than a one-off in a chat log.

- [ ] **Step 8: Hand off for manual testing**

Manual test matrix for the user:

| # | Action | Expected link in the mail |
|---|---|---|
| 1 | Seeker on :5174 applies to a provider | Seeker's "application sent" mail → `http://localhost:5174/auth/login` |
| 2 | Same action, provider's copy | Provider's "a seeker applied" mail → `http://localhost:5175/auth/login` |
| 3 | Provider accepts | Seeker's status mail → `:5174`; provider's → `:5175` |
| 4 | Seeker retires their profile | Cancelled provider counterparty's mail → `:5175` |
| 5 | Brand-new signup on :5175 | Welcome mail link → `:5175/auth/login` |

Nothing may link to `http://localhost:9999` — that is the stand-in for the blocked front-door.

- [ ] **Step 9: Commit**

```bash
git add docs/operations/local-split-ui.md
git commit -m "docs: runbook for the local split-UI stack (#569)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Config input `UI_HOST_BINDINGS` | 1, 2 |
| 2. Resolution module (parse, first-wins, boot cross-check) | 1, 2, 3 |
| 3. Action + retire, incl. the gate fix | 4, 5 |
| 4. Welcome | 6 |
| 5. Infra | 7 |
| 6. `turbo.json` | 2 |
| Error-handling table | 1 (parse), 3 (fallback), 4 (gate + dead-href guard), 5 |
| Testing section | 1, 3, 4, 5, 6 |
| Out of scope: login-OTP, support subject, templates | no task, by design |

**Deviations from the spec, both deliberate:**
1. **Scheme prefix allowed** on the host half — required for Task 8; recorded under "Spec amendment adopted by this plan".
2. **Skip rather than send a dead `href=""`.** The spec's error table says an unmapped domain "falls back to `FRONTEND_BASE_URL`" — but with a map-only config there is no scalar to fall back to, and `dispatch_email.ts:136` (`args.ctaUrl ?? ''`) would ship `<a href="">`. Tasks 4 and 5 skip that recipient and log instead. The spec's error table should gain this row.
3. **First-wins on a duplicate domain**, where the aggregator's parser is last-wins. A vanity alias listed after the canonical host must not displace it. Documented in the code comment and asserted in Task 1.

**Type consistency:** `resolveCtaUrl: (domain: string) => string | undefined` is used identically in `createCtaUrlResolver` (Task 3), `DispatcherDeps` (Task 4), `NotifierConfig` (Task 4) and `notify_retire.ts` (Task 5). `byDomain` is `Record<string, string>` throughout. `DispatchEmailArgs.ctaUrl` is already `string | undefined` (`dispatch_email.ts:62`), so passing an unresolved value needs no signature change there.
