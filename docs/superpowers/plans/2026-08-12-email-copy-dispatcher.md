# Email Copy Externalization + Single Dispatcher (#529) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every hardcoded email subject/body into one overridable `messages.default.properties` file (ConfigMap-overridable via `EMAIL_MESSAGES_PATH`) and route all 6 email `notify()` call sites through one `dispatchEmail()` sender with per-case critical/best-effort error policy.

**Architecture:** New module `apps/api/src/notifications/email/` = properties parser → boot-time loader (per-key merge of override onto bundled defaults) → case registry (copy keys, typed tokens, shell, criticality, priority) → `createEmailSender().dispatchEmail()` (substitute → shell → notification client). `packages/auth` receives an injected `sendEmail` callback via `AuthRuntimeConfig` instead of building HTML itself. Wire `template_id` stays `basic_email` (the notification service accepts nothing else).

**Tech Stack:** TypeScript ESM (strict, no `any`), Fastify API, vitest, pnpm/Turborepo. No new dependencies — the properties parser is ~30 lines of hand-rolled code.

**Spec:** `docs/superpowers/specs/2026-08-12-email-copy-dispatcher-design.md` — read it first.

## Global Constraints

- Branch: `feat/529-email-copy-dispatcher` (already created off `feature`). Commit after every task. Never push to `feature`/`develop`.
- Files snake_case; Zod schemas PascalCase; `import type` for type-only imports; no `// TODO` comments; no `console.log` in library packages (`packages/*` — `console.error` in existing auth catch blocks is the established pattern there and stays).
- **Copy is migrated verbatim** — every subject/body string in `messages.default.properties` must be byte-identical to today's TS strings (including curly apostrophes `’` and em/en dashes), except: token syntax `{name}` → `{{name}}`, and bodies gain their own `<p>` wrappers (the cta shell stops wrapping).
- Escaping rule (non-negotiable): properties copy inserted raw; `text` tokens HTML-escaped on substitution; `html` tokens only ever built in code from escaped parts; unknown `{{...}}` left verbatim.
- Criticality: `guardian.*`, `otp.generic`, `login.otp`, `support.request` = **critical** (dispatch throws); `action.*`, `retire.cancel`, `welcome` = **best_effort** (never throws, logs, returns `{ok:false}`).
- Test commands: single file `pnpm --filter api exec vitest run <path>`; whole suite `pnpm --filter api test`; auth package `pnpm --filter auth test` (check `packages/auth/package.json` for the exact script name; if there is no test script, run `pnpm --filter auth exec vitest run`); typecheck `pnpm typecheck` (run from repo root: `/Users/srivastha/KKB/Github/Signals-DPG.worktrees/email-copy-dispatcher`).
- Run all commands from the worktree root above. Do NOT touch `/Users/srivastha/KKB/Github/Signals-DPG` (other work in progress).

---

### Task 1: Properties parser

**Files:**
- Create: `apps/api/src/notifications/email/parse_properties.ts`
- Test: `apps/api/src/notifications/email/__tests__/parse_properties.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseProperties(text: string): ParsedProperties` where `ParsedProperties = { entries: Map<string, string>; malformedLines: number[] }`. Rules: blank lines and lines whose first non-space char is `#` or `!` are skipped; everything else must contain `=` (split at the FIRST `=`; key trimmed, value trimmed); lines without `=` are recorded (1-based) in `malformedLines` and skipped. Duplicate keys: last one wins. No escape sequences, no line continuation.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/parse_properties.test.ts
import { describe, expect, it } from 'vitest';
import { parseProperties } from '../parse_properties';

describe('parseProperties', () => {
  it('parses key=value lines, trimming key and value', () => {
    const { entries } = parseProperties('a.b=hello\n  c.d  =  world  \n');
    expect(entries.get('a.b')).toBe('hello');
    expect(entries.get('c.d')).toBe('world');
  });

  it('splits at the FIRST = so values may contain =', () => {
    const { entries } = parseProperties('k=a=b=c');
    expect(entries.get('k')).toBe('a=b=c');
  });

  it('skips blank lines and # / ! comments', () => {
    const { entries, malformedLines } = parseProperties(
      '# comment\n! also comment\n\n   \nkey=v\n',
    );
    expect(entries.size).toBe(1);
    expect(malformedLines).toEqual([]);
  });

  it('records 1-based malformed (no =) line numbers and skips them', () => {
    const { entries, malformedLines } = parseProperties('good=1\nbadline\nalso=2\n');
    expect(malformedLines).toEqual([2]);
    expect(entries.size).toBe(2);
  });

  it('keeps inline HTML and {{tokens}} in values untouched', () => {
    const { entries } = parseProperties(
      'b=<p>{{name}} has <b>bold</b> — and ’quotes’</p>',
    );
    expect(entries.get('b')).toBe('<p>{{name}} has <b>bold</b> — and ’quotes’</p>');
  });

  it('last duplicate key wins', () => {
    const { entries } = parseProperties('k=first\nk=second');
    expect(entries.get('k')).toBe('second');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/parse_properties.test.ts`
Expected: FAIL — cannot resolve `../parse_properties`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/notifications/email/parse_properties.ts
/**
 * Minimal Java-properties-style parser for the email messages file (#529).
 * Deliberately tiny: `key=value` per line, `#`/`!` comments, split at the
 * first `=`, no escape sequences, no line continuation. Values are HTML
 * fragments and may contain further `=` characters.
 */
export interface ParsedProperties {
  entries: Map<string, string>;
  /** 1-based line numbers that were neither blank/comment nor `key=value`. */
  malformedLines: number[];
}

export function parseProperties(text: string): ParsedProperties {
  const entries = new Map<string, string>();
  const malformedLines: number[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) {
      malformedLines.push(i + 1);
      continue;
    }
    entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  return { entries, malformedLines };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/parse_properties.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): properties parser for externalized email copy (#529)"
```

---

### Task 2: Token substitution with escaping (the XSS boundary)

**Files:**
- Create: `apps/api/src/notifications/email/substitute.ts`
- Test: `apps/api/src/notifications/email/__tests__/substitute.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `escapeHtml(value: string): string` (the canonical copy — later tasks delete the 3 duplicates elsewhere)
  - `type TokenTypes = Record<string, 'text' | 'html'>`
  - `substituteHtml(template: string, variables: Record<string, string>, tokens: TokenTypes): string` — HTML context: `text` tokens escaped, `html` tokens raw, any `{{name}}` that is undeclared in `tokens` OR has no value in `variables` is left verbatim.
  - `substitutePlain(template: string, variables: Record<string, string>, tokens: TokenTypes): string` — plain-text context (subjects): recognised tokens substituted UNescaped, same leave-verbatim rule.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/substitute.test.ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, substituteHtml, substitutePlain } from '../substitute';

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });
});

describe('substituteHtml', () => {
  it('escapes text tokens (XSS acceptance test)', () => {
    const out = substituteHtml(
      '<p>{{name}} says hi</p>',
      { name: '<script>alert(1)</script>' },
      { name: 'text' },
    );
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; says hi</p>');
  });

  it('preserves inline HTML in the trusted template', () => {
    const out = substituteHtml('<p><b>{{name}}</b></p>', { name: 'Anu' }, { name: 'text' });
    expect(out).toBe('<p><b>Anu</b></p>');
  });

  it('inserts html tokens raw', () => {
    const out = substituteHtml('{{orgList}}', { orgList: '<ol><li>A</li></ol>' }, { orgList: 'html' });
    expect(out).toBe('<ol><li>A</li></ol>');
  });

  it('leaves undeclared tokens verbatim (typos are visible, not fatal)', () => {
    const out = substituteHtml('<p>{{otpp}}</p>', { otp: '123456' }, { otp: 'text' });
    expect(out).toBe('<p>{{otpp}}</p>');
  });

  it('leaves declared-but-unprovided tokens verbatim', () => {
    const out = substituteHtml('<p>{{name}}</p>', {}, { name: 'text' });
    expect(out).toBe('<p>{{name}}</p>');
  });

  it('replaces repeated tokens everywhere', () => {
    const out = substituteHtml('{{org}} and {{org}}', { org: 'A&B' }, { org: 'text' });
    expect(out).toBe('A&amp;B and A&amp;B');
  });
});

describe('substitutePlain', () => {
  it('substitutes without escaping (subjects are not HTML)', () => {
    const out = substitutePlain('Sent to {{name}}', { name: "R&D <dept>" }, { name: 'text' });
    expect(out).toBe('Sent to R&D <dept>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/substitute.test.ts`
Expected: FAIL — cannot resolve `../substitute`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/notifications/email/substitute.ts
/**
 * `{{token}}` substitution for externalized email copy (#529).
 *
 * Security boundary: template text comes from the reviewed properties file and
 * is trusted (inserted raw so inline HTML works). Variable VALUES are runtime
 * data: `text` tokens are HTML-escaped on substitution; `html` tokens are
 * inserted raw and may only be produced in code from already-escaped parts.
 * Substitution is best-effort — an undeclared or unprovided `{{token}}` is
 * left in the output verbatim, never an error.
 */
export type TokenTypes = Record<string, 'text' | 'html'>;

const TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substitute(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
  escapeText: boolean,
): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    const type = tokens[name];
    const value = variables[name];
    if (type === undefined || value === undefined) return match;
    if (type === 'html') return value;
    return escapeText ? escapeHtml(value) : value;
  });
}

/** HTML context (bodies): text tokens escaped, html tokens raw. */
export function substituteHtml(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
): string {
  return substitute(template, variables, tokens, true);
}

/** Plain-text context (subjects): recognised tokens substituted unescaped. */
export function substitutePlain(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
): string {
  return substitute(template, variables, tokens, false);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/substitute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): token substitution with text/html escaping rules (#529)"
```

---

### Task 3: Email case registry

**Files:**
- Create: `apps/api/src/notifications/email/email_cases.ts`
- Test: `apps/api/src/notifications/email/__tests__/email_cases.test.ts`

**Interfaces:**
- Consumes: `TokenTypes` from `./substitute`.
- Produces (used by every later task):
  - `type EmailShell = 'cta' | 'plain'`; `type EmailCriticality = 'critical' | 'best_effort'`
  - `interface EmailCaseDef { keys: { subject: string; body: string; cta?: string }; tokens: TokenTypes; shell: EmailShell; criticality: EmailCriticality; priority: 'realtime' | 'other' }`
  - `getEmailCase(caseId: string): EmailCaseDef` — throws `Error('unknown email case: <id>')` for unknown ids
  - `actionCaseId(group: 'connect' | 'apply', role: 'seeker' | 'provider', shape: string): string` — returns `action.<group>.<role>.<shape.toLowerCase()>`
  - `requiredMessageKeys(): string[]` — every `keys.*` value across all cases, deduped
  - `EMAIL_CASE_IDS: string[]` — all case ids

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/email_cases.test.ts
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CASE_IDS,
  actionCaseId,
  getEmailCase,
  requiredMessageKeys,
} from '../email_cases';

describe('email case registry', () => {
  it('has 16 action cases + 9 named cases', () => {
    const actions = EMAIL_CASE_IDS.filter((id) => id.startsWith('action.'));
    expect(actions).toHaveLength(16);
    for (const id of [
      'retire.cancel',
      'guardian.account',
      'guardian.profile',
      'guardian.action',
      'guardian.action_bulk',
      'otp.generic',
      'login.otp',
      'welcome',
      'support.request',
    ]) {
      expect(EMAIL_CASE_IDS).toContain(id);
    }
    expect(EMAIL_CASE_IDS).toHaveLength(25);
  });

  it('maps plan fields to an action case id', () => {
    expect(actionCaseId('connect', 'seeker', 'INBOUND_REQUEST')).toBe(
      'action.connect.seeker.inbound_request',
    );
    expect(getEmailCase('action.connect.seeker.inbound_request').keys.subject).toBe(
      'action.connect.seeker.inbound_request.subject',
    );
  });

  it('classifies criticality per the spec', () => {
    expect(getEmailCase('guardian.account').criticality).toBe('critical');
    expect(getEmailCase('login.otp').criticality).toBe('critical');
    expect(getEmailCase('support.request').criticality).toBe('critical');
    expect(getEmailCase('action.connect.seeker.inbound_request').criticality).toBe('best_effort');
    expect(getEmailCase('retire.cancel').criticality).toBe('best_effort');
    expect(getEmailCase('welcome').criticality).toBe('best_effort');
  });

  it('only allowlists the three code-built html tokens', () => {
    const htmlTokens = new Set<string>();
    for (const id of EMAIL_CASE_IDS) {
      const def = getEmailCase(id);
      for (const [name, type] of Object.entries(def.tokens)) {
        if (type === 'html') htmlTokens.add(name);
      }
    }
    expect([...htmlTokens].sort()).toEqual(['detailsTable', 'orgList', 'otpBox']);
  });

  it('throws for unknown case ids', () => {
    expect(() => getEmailCase('nope')).toThrow('unknown email case: nope');
  });

  it('requiredMessageKeys covers subject+body(+cta) for every case', () => {
    const keys = requiredMessageKeys();
    // 17 cta-shell cases × 3 keys + 8 plain cases × 2 keys = 67
    expect(keys).toHaveLength(67);
    expect(keys).toContain('retire.cancel.cta');
    expect(keys).toContain('welcome.body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/email_cases.test.ts`
Expected: FAIL — cannot resolve `../email_cases`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/notifications/email/email_cases.ts
import type { TokenTypes } from './substitute';

/**
 * The email case registry (#529): one entry per email the system sends. This
 * is the issue's "stable template_ids per case" — internal to Signals; the
 * wire template_id stays 'basic_email' (the notification service's email
 * provider registers no other template).
 *
 * Per case: which properties-file keys hold its copy, which {{tokens}} its
 * copy may use (text = escaped on substitution, html = code-built raw
 * fragments), which HTML shell wraps the body, whether a send failure is
 * critical (throws to the caller) or best-effort (logged, never blocks the
 * triggering action), and the notification-service priority.
 */
export type EmailShell = 'cta' | 'plain';
export type EmailCriticality = 'critical' | 'best_effort';

export interface EmailCaseDef {
  keys: { subject: string; body: string; cta?: string };
  tokens: TokenTypes;
  shell: EmailShell;
  criticality: EmailCriticality;
  priority: 'realtime' | 'other';
}

const ACTION_GROUPS = ['connect', 'apply'] as const;
const ACTION_ROLES = ['seeker', 'provider'] as const;
const ACTION_SHAPES = [
  'inbound_request',
  'outbound_request',
  'inbound_status',
  'outbound_status',
] as const;

function ctaCase(prefix: string, tokens: TokenTypes): EmailCaseDef {
  return {
    keys: { subject: `${prefix}.subject`, body: `${prefix}.body`, cta: `${prefix}.cta` },
    tokens,
    shell: 'cta',
    criticality: 'best_effort',
    priority: 'other',
  };
}

function plainCase(
  prefix: string,
  tokens: TokenTypes,
  criticality: EmailCriticality,
  priority: 'realtime' | 'other',
): EmailCaseDef {
  return {
    keys: { subject: `${prefix}.subject`, body: `${prefix}.body` },
    tokens,
    shell: 'plain',
    criticality,
    priority,
  };
}

const CASES = new Map<string, EmailCaseDef>();

for (const group of ACTION_GROUPS) {
  for (const role of ACTION_ROLES) {
    for (const shape of ACTION_SHAPES) {
      const id = `action.${group}.${role}.${shape}`;
      CASES.set(id, ctaCase(id, { name: 'text' }));
    }
  }
}

CASES.set('retire.cancel', ctaCase('retire.cancel', {}));

const GUARDIAN_TOKENS: TokenTypes = {
  parentName: 'text',
  domain: 'text',
  org: 'text',
  otp: 'text',
  otpBox: 'html',
  teamName: 'text',
};
CASES.set('guardian.account', plainCase('guardian.account', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set('guardian.profile', plainCase('guardian.profile', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set('guardian.action', plainCase('guardian.action', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set(
  'guardian.action_bulk',
  plainCase(
    'guardian.action_bulk',
    { ...GUARDIAN_TOKENS, noun: 'text', orgList: 'html' },
    'critical',
    'realtime',
  ),
);
CASES.set('otp.generic', plainCase('otp.generic', { otp: 'text' }, 'critical', 'realtime'));
CASES.set(
  'login.otp',
  plainCase(
    'login.otp',
    { userName: 'text', signAction: 'text', appName: 'text', otp: 'text', otpBox: 'html' },
    'critical',
    'realtime',
  ),
);
CASES.set(
  'welcome',
  plainCase('welcome', { userName: 'text', appName: 'text' }, 'best_effort', 'realtime'),
);
CASES.set(
  'support.request',
  plainCase(
    'support.request',
    {
      reference: 'text',
      type: 'text',
      name: 'text',
      fromSite: 'text',
      details: 'text',
      detailsTable: 'html',
      teamName: 'text',
    },
    'critical',
    'other',
  ),
);

export const EMAIL_CASE_IDS: string[] = [...CASES.keys()];

export function getEmailCase(caseId: string): EmailCaseDef {
  const def = CASES.get(caseId);
  if (!def) throw new Error(`unknown email case: ${caseId}`);
  return def;
}

export function actionCaseId(
  group: 'connect' | 'apply',
  role: 'seeker' | 'provider',
  shape: string,
): string {
  return `action.${group}.${role}.${shape.toLowerCase()}`;
}

/** Every properties key the bundled defaults file must define. */
export function requiredMessageKeys(): string[] {
  const keys: string[] = [];
  for (const def of CASES.values()) {
    keys.push(def.keys.subject, def.keys.body);
    if (def.keys.cta) keys.push(def.keys.cta);
  }
  return keys;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/email_cases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): email case registry — copy keys, tokens, shell, criticality (#529)"
```

---

### Task 4: HTML shells + code-built fragments

**Files:**
- Create: `apps/api/src/notifications/email/shells.ts`
- Test: `apps/api/src/notifications/email/__tests__/shells.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `./substitute`; `resolveBrandColor` stays in `../brand` (unchanged).
- Produces:
  - `renderCtaShell(args: { introHtml: string; ctaUrl: string; ctaLabel: string; ctaColor: string; brandName: string }): string` — the branded action shell, moved from `render_action_email.ts` with ONE change: `introHtml` is inserted WITHOUT a `<p>` wrapper (bodies now carry their own `<p>`).
  - `renderPlainShell(bodyHtml: string): string` — just the Arial wrapper div.
  - `renderOtpBox(otp: string): string` — the styled monospace code box (from `guardian_otp_email.ts` / `otp_email.ts`), OTP escaped.
  - `renderOrgList(names: string[]): string` — `<ol>` of escaped `<li>`s, or `<p>the selected organisations</p>` when empty (verbatim from `guardian_otp_email.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/shells.test.ts
import { describe, expect, it } from 'vitest';
import { renderCtaShell, renderOrgList, renderOtpBox, renderPlainShell } from '../shells';

describe('renderCtaShell', () => {
  const args = {
    introHtml: '<p>Custom <b>body</b></p>',
    ctaUrl: 'https://x.example/auth/login',
    ctaLabel: 'View "details"',
    ctaColor: '#2563eb',
    brandName: 'Blue <Dot>',
  };

  it('inserts the body raw and escapes url/label/brand', () => {
    const html = renderCtaShell(args);
    expect(html).toContain('<p>Custom <b>body</b></p>');
    expect(html).not.toContain('<p><p>'); // no double wrapping
    expect(html).toContain('View &quot;details&quot;');
    expect(html).toContain('Team Blue &lt;Dot&gt;');
    expect(html).toContain('background-color:#2563eb');
    expect(html).toContain('href="https://x.example/auth/login"');
  });
});

describe('renderPlainShell', () => {
  it('wraps the body in the font div only', () => {
    const html = renderPlainShell('<p>hello</p>');
    expect(html).toContain('font-family: Arial');
    expect(html).toContain('<p>hello</p>');
  });
});

describe('renderOtpBox', () => {
  it('escapes the code and uses the monospace box', () => {
    const html = renderOtpBox('12<34');
    expect(html).toContain('12&lt;34');
    expect(html).toContain('Courier New');
  });
});

describe('renderOrgList', () => {
  it('renders an ordered list of escaped names', () => {
    expect(renderOrgList(['A&B', 'C'])).toBe('<ol><li>A&amp;B</li><li>C</li></ol>');
  });
  it('falls back for an empty list', () => {
    expect(renderOrgList([])).toBe('<p>the selected organisations</p>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/shells.test.ts`
Expected: FAIL — cannot resolve `../shells`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/notifications/email/shells.ts
import { escapeHtml } from './substitute';

/**
 * HTML shells + code-built fragments for externalized email copy (#529).
 * The shell is the escaping/layout boundary and stays in code on purpose —
 * the properties file holds words, not structure. Fragments returned by
 * `renderOtpBox`/`renderOrgList` are the only values allowed into `html`
 * tokens: built here from escaped parts.
 */

/** Branded action shell (greeting, body, CTA button + fallback link, sign-off). */
export function renderCtaShell(args: {
  introHtml: string;
  ctaUrl: string;
  ctaLabel: string;
  ctaColor: string;
  brandName: string;
}): string {
  const { introHtml, ctaUrl, ctaLabel, ctaColor, brandName } = args;
  const url = escapeHtml(ctaUrl);
  const brand = escapeHtml(brandName);
  const label = escapeHtml(ctaLabel);
  return `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    <p>Hi!</p>
    ${introHtml}
    <p style="margin: 20px 0;">
      <a href="${url}" style="background-color:${ctaColor};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;">${label}</a>
    </p>
    <p style="font-size:13px;color:#555;">Or open this link: <a href="${url}" style="color:${ctaColor};">${url}</a></p>
    <p style="margin-top:24px;">Thanks,<br/>Team ${brand}</p>
  </div>`;
}

/** Plain shell: the font wrapper only — sign-offs live in the copy. */
export function renderPlainShell(bodyHtml: string): string {
  return `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    ${bodyHtml}
  </div>`;
}

/** The monospace OTP code box (shared by guardian + login OTP emails). */
export function renderOtpBox(otp: string): string {
  return `<div style="
      font-size: 20px;
      font-weight: bold;
      background-color: #f4f4f4;
      padding: 10px 15px;
      border-radius: 6px;
      display: inline-block;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
    ">${escapeHtml(otp)}</div>`;
}

/** Numbered provider-org list for the guardian bulk email (#393). */
export function renderOrgList(names: string[]): string {
  if (names.length === 0) return '<p>the selected organisations</p>';
  return `<ol>${names.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ol>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/shells.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): email HTML shells + otp-box/org-list fragments (#529)"
```

---

### Task 5: Bundled defaults file + registry-completeness test

**Files:**
- Create: `apps/api/src/notifications/email/messages.default.properties`
- Test: `apps/api/src/notifications/email/__tests__/messages_default.test.ts`

**Interfaces:**
- Consumes: `parseProperties`, `requiredMessageKeys`, `getEmailCase`, `EMAIL_CASE_IDS`.
- Produces: the canonical copy file. Later tasks rely on these exact keys.

**Copy sources (migrate VERBATIM, `{name}` → `{{name}}`, bodies wrapped in `<p>…</p>`):**
- `action.*` + `retire.cancel`: `apps/api/src/notifications/action_copy.ts` `COPY` table + `RETIRE_CANCEL_COPY` (the file stays untouched until Task 8 — copy the strings, don't delete yet).
- `guardian.*` / `otp.generic`: `apps/api/src/services/guardian_otp_email.ts` (`bodyLine`, `subjectFor`, the shared greeting/validity/sign-off lines) and the inline fallback in `guardian_otp.ts:226-227`.
- `login.otp`: `packages/auth/src/templates/otp_email.ts`. `welcome`: `packages/auth/src/config.ts:191-193`.
- `support.request`: `apps/api/src/support/build_support_email.ts:79-111`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/messages_default.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMAIL_CASE_IDS, getEmailCase, requiredMessageKeys } from '../email_cases';
import { parseProperties } from '../parse_properties';

const TEXT = readFileSync(
  new URL('../messages.default.properties', import.meta.url),
  'utf8',
);

describe('messages.default.properties', () => {
  const { entries, malformedLines } = parseProperties(TEXT);

  it('parses with no malformed lines', () => {
    expect(malformedLines).toEqual([]);
  });

  it('defines every key the registry requires', () => {
    const missing = requiredMessageKeys().filter((k) => !entries.has(k));
    expect(missing).toEqual([]);
  });

  it('has no keys the registry does not know (catches typos both ways)', () => {
    const known = new Set(requiredMessageKeys());
    const unknown = [...entries.keys()].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('only references tokens declared for each case', () => {
    const offenders: string[] = [];
    for (const id of EMAIL_CASE_IDS) {
      const def = getEmailCase(id);
      for (const key of [def.keys.subject, def.keys.body, def.keys.cta].filter(
        (k): k is string => Boolean(k),
      )) {
        const value = entries.get(key) ?? '';
        for (const m of value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
          if (!(m[1] in def.tokens)) offenders.push(`${key} -> {{${m[1]}}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps a spot-checked string verbatim from the old copy table', () => {
    expect(entries.get('action.connect.seeker.inbound_request.subject')).toBe(
      'A service provider wants to connect with you',
    );
    expect(entries.get('action.apply.seeker.inbound_request.subject')).toBe(
      '{{name}} has shown interest in your profile',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/messages_default.test.ts`
Expected: FAIL — ENOENT (file does not exist).

- [ ] **Step 3: Write the defaults file**

Write `apps/api/src/notifications/email/messages.default.properties` with EXACTLY this content (the 12 action variants elided below MUST be filled in the same way from `action_copy.ts` — every subject/body/ctaLabel string copied byte-for-byte, `{name}` → `{{name}}`, body wrapped in `<p>…</p>`):

```properties
# Email copy for Signals (#529). One key per line: <case>.<field>=<text>.
# Bodies are HTML fragments — light inline HTML is allowed: <p> <b> <a> <ol> <li>.
# The outer layout (header, CTA button, styling) is fixed in code and cannot
# be changed here. To override this copy at deploy time, mount a ConfigMap
# copy of this file and point EMAIL_MESSAGES_PATH at it — any key you omit
# falls back to the bundled default for that key.
#
# Placeholders are written {{likeThis}}. They are optional — use the ones you
# need. Anything not recognised is left in the email as-is, exactly as typed.

# ── Action emails ────────────────────────────────────────────────────
# Keys: action.<group>.<role>.<shape>.{subject|body|cta}
#   group: connect | apply     role: seeker | provider
#   shape: inbound_request | outbound_request | inbound_status | outbound_status
# Placeholders: {{name}} — the counterparty provider's service name
#   (seeker-facing copy only; provider-facing copy keeps the seeker generic).
# The .cta key is the button label; the button link is configured, not copy.

action.connect.seeker.inbound_request.subject=A service provider wants to connect with you
action.connect.seeker.inbound_request.body=<p>{{name}} has expressed interest in connecting with you. They may have an opportunity or service that matches what you’re looking for. Click below to view the details and respond.</p>
action.connect.seeker.inbound_request.cta=View the details and respond

action.connect.seeker.outbound_request.subject=Your connection request has been sent to {{name}}
action.connect.seeker.outbound_request.body=<p>Your request for service has been successfully sent to {{name}}. They will be notified and will respond shortly. Click below to track your request.</p>
action.connect.seeker.outbound_request.cta=Track your request

action.connect.seeker.inbound_status.subject={{name}} has responded to your connection request
action.connect.seeker.inbound_status.body=<p>{{name}} has responded to your connection request. Check the latest update and take the next step. Click below to view their response.</p>
action.connect.seeker.inbound_status.cta=View their response

action.connect.seeker.outbound_status.subject=Your response has been sent to {{name}}
action.connect.seeker.outbound_status.body=<p>Your response to {{name}}’s connection request has been sent successfully. They will be notified. Click below to view the details.</p>
action.connect.seeker.outbound_status.cta=View the details

# … the 12 remaining action variants (connect.provider.*, apply.seeker.*,
# apply.provider.*) migrated the same way from action_copy.ts …

# ── Retire cancellation ──────────────────────────────────────────────
# No placeholders — deliberately PII-free (#418): the retired profile is
# already scrubbed, so this email names nothing about it.
retire.cancel.subject=A connection has been cancelled
retire.cancel.body=<p>A profile you were connected with has been retired and is no longer available, so your active connection with it has been cancelled. No action is needed on your part.</p>
retire.cancel.cta=View your connections

# ── Guardian OTP emails (#294) ───────────────────────────────────────
# Placeholders: {{parentName}} guardian's name ("there" when unknown)
#   {{domain}}   the website/network name    {{org}} the provider organisation
#   {{otp}}      the code as plain text      {{otpBox}} the code in a styled box
#   {{teamName}} the brand sign-off name
#   {{noun}}     (action_bulk) "jobs" or "opportunities"
#   {{orgList}}  (action_bulk) numbered list of every provider organisation
guardian.account.subject=Approve your ward's account — OTP
guardian.account.body=<p>Hi {{parentName}},</p><p>Your ward has requested registration on <b>{{domain}}</b>. This website shows services and opportunities relevant to your ward. Use the given OTP to agree to create their account.</p>{{otpBox}}<p style="font-size: 13px; color: #555;">This OTP is valid for 10 minutes. Do not share it with anyone.</p><p>Team {{teamName}}</p>

guardian.profile.subject=Approve your ward's profile — OTP
guardian.profile.body=<p>Hi {{parentName}},</p><p>Your ward has requested to create a profile on <b>{{domain}}</b>. This profile will help your ward in discovering, and matching to relevant services and opportunities. Use the given OTP to agree to create their profile.</p>{{otpBox}}<p style="font-size: 13px; color: #555;">This OTP is valid for 10 minutes. Do not share it with anyone.</p><p>Team {{teamName}}</p>

guardian.action.subject=Approve your ward's request — OTP
guardian.action.body=<p>Hi {{parentName}},</p><p>Your ward has requested to connect to <b>{{org}}</b>. This will share your ward's profile details, along with name, phone, and email with the organisation. Use the given OTP to allow <b>{{org}}</b> to access your ward's details.</p>{{otpBox}}<p style="font-size: 13px; color: #555;">This OTP is valid for 10 minutes. Do not share it with anyone.</p><p>Team {{teamName}}</p>

guardian.action_bulk.subject=Approve your ward's requests — OTP
guardian.action_bulk.body=<p>Hi {{parentName}},</p><p>Your ward has requested to apply to {{noun}} provided by:</p>{{orgList}}<p>This application will share your ward's profile details, along with name, phone, and email with the organisations. Use the given OTP to allow provider organisations to access your ward's details.</p>{{otpBox}}<p style="font-size: 13px; color: #555;">This OTP is valid for 10 minutes. Do not share it with anyone.</p><p>Team {{teamName}}</p>

# Scenario-less guardian OTP fallback. Placeholders: {{otp}}
otp.generic.subject=Your One-Time Password (OTP)
otp.generic.body=<p>Use this OTP: <b>{{otp}}</b></p><p>This OTP is valid for 10 minutes. Do not share it with anyone.</p>

# ── Login OTP ────────────────────────────────────────────────────────
# Placeholders: {{userName}} recipient's name ("user" when unknown)
#   {{signAction}} "sign in" or "sign up"   {{appName}} the instance name
#   {{otp}} plain code   {{otpBox}} the code in a styled box
login.otp.subject=Your One-Time Password (OTP) for {{appName}}
login.otp.body=<p>Hi, <span style="text-transform: capitalize;">{{userName}}</span></p><p>Use the following One-Time Password (OTP) to <strong>{{signAction}}</strong> to <b>{{appName}}</b>:</p>{{otpBox}}<p style="font-size: 13px; color: #555;">This OTP is valid for 5 minutes. Do not share it with anyone.</p>

# ── Welcome (post-signup) ────────────────────────────────────────────
# Placeholders: {{userName}} {{appName}}
welcome.subject=Welcome!
welcome.body=<p>Congratulations {{userName}}! You just went live with an account on {{appName}}.</p>

# ── Support / contact form (#120) ────────────────────────────────────
# Placeholders: {{reference}} the SUP-… reference   {{type}} Complaint/Support Request
#   {{name}} submitter's name   {{fromSite}} " from <site url>" or empty
#   {{details}} the submitted message   {{detailsTable}} contact-details table
#   {{teamName}} sign-off
support.request.subject=Issue Number: {{reference}} — {{type}} from {{name}}{{fromSite}}
support.request.body=<p>The below {{type}} has been raised by {{name}}</p><p style="white-space:pre-wrap">{{details}}</p><hr />{{detailsTable}}<hr /><p style="margin:8px 0 0">Regards,<br />Team {{teamName}}</p>
```

**Filling the elided 12 action variants:** open `apps/api/src/notifications/action_copy.ts:79-149`, and for each of `connect.provider.{4 shapes}`, `apply.seeker.{4 shapes}`, `apply.provider.{4 shapes}` emit the three keys exactly like the four shown above. The spot-check test asserts one of them.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/messages_default.test.ts`
Expected: PASS. If "defines every key" fails, the diff of missing keys tells you which variant you skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): bundled default email messages file, all copy migrated verbatim (#529)"
```

---

### Task 6: Loader + `EMAIL_MESSAGES_PATH` env + build packaging

**Files:**
- Create: `apps/api/src/notifications/email/messages.ts`
- Modify: `packages/config/src/secrets.ts` (NotificationSecretsSchema, after `SUPPORT_CC_EMAIL` ~line 101)
- Modify: `turbo.json` (add `"EMAIL_MESSAGES_PATH"` to the global env list, alphabetically near line 22)
- Modify: `apps/api/tsup.config.ts` (copy the properties file into `dist/`)
- Test: `apps/api/src/notifications/email/__tests__/messages.test.ts`

**Interfaces:**
- Consumes: `parseProperties`, `requiredMessageKeys`, `EMAIL_CASE_IDS`, `getEmailCase`; `notification.EMAIL_MESSAGES_PATH` from `@/config`.
- Produces:
  - `interface EmailMessages { get(key: string): string }` — `get` throws for a key not in the merged map (cannot happen for registry keys after validation).
  - `loadEmailMessages(opts: { defaultsText: string; overrideText?: string | null; warn?: (message: string) => void }): EmailMessages` — pure, fully unit-testable.
  - `getEmailMessages(): Promise<EmailMessages>` — singleton promise (the `network_configs.ts` pattern); reads the bundled file via `new URL('./messages.default.properties', import.meta.url)` and the override from `notification.EMAIL_MESSAGES_PATH` (unreadable override → warn + defaults).
  - `resetEmailMessagesForTests(): void`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/messages.test.ts
import { describe, expect, it, vi } from 'vitest';
import { loadEmailMessages } from '../messages';
import { requiredMessageKeys } from '../email_cases';

/** Minimal valid defaults: every required key present. */
function fullDefaults(): string {
  return requiredMessageKeys()
    .map((k) => `${k}=default ${k}`)
    .join('\n');
}

describe('loadEmailMessages', () => {
  it('throws at load when the bundled defaults are incomplete', () => {
    expect(() => loadEmailMessages({ defaultsText: 'welcome.subject=x' })).toThrow(
      /bundled email messages file is missing/,
    );
  });

  it('serves defaults when no override is given', () => {
    const m = loadEmailMessages({ defaultsText: fullDefaults() });
    expect(m.get('welcome.subject')).toBe('default welcome.subject');
  });

  it('merges per-key: override wins, everything else falls back', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcome.subject=Custom hello!',
      warn,
    });
    expect(m.get('welcome.subject')).toBe('Custom hello!');
    expect(m.get('welcome.body')).toBe('default welcome.body');
  });

  it('warns about unknown override keys (typo catcher)', () => {
    const warn = vi.fn();
    loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcom.subject=typo',
      warn,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('welcom.subject'));
  });

  it('warns about undeclared placeholders but keeps the value as written', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcome.body=<p>{{otpp}}</p>',
      warn,
    });
    expect(m.get('welcome.body')).toBe('<p>{{otpp}}</p>');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{otpp}}'));
  });

  it('warns about malformed override lines and ignores them', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'this line has no equals\nwelcome.subject=ok',
      warn,
    });
    expect(m.get('welcome.subject')).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line 1'));
  });

  it('get() throws for unknown keys', () => {
    const m = loadEmailMessages({ defaultsText: fullDefaults() });
    expect(() => m.get('nope.nope')).toThrow('unknown email message key: nope.nope');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/messages.test.ts`
Expected: FAIL — cannot resolve `../messages`.

- [ ] **Step 3: Write the loader**

```ts
// apps/api/src/notifications/email/messages.ts
import { readFile } from 'node:fs/promises';

import { notification } from '@/config';

import { EMAIL_CASE_IDS, getEmailCase, requiredMessageKeys } from './email_cases';
import { parseProperties } from './parse_properties';

/**
 * Boot-time loader for the email messages file (#529). Bundled defaults ship
 * next to this module; an ops override (ConfigMap mount) is pointed at by
 * EMAIL_MESSAGES_PATH and merged PER KEY — a typo'd or partial override can
 * never take email down, it just falls back key-by-key with a warning.
 * Loaded once per process (singleton promise, the network_configs pattern);
 * copy changes apply on restart/deploy.
 */
export interface EmailMessages {
  get(key: string): string;
}

const TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/** Warn when a copy value references a placeholder its case never provides. */
function lintPlaceholders(
  entries: Map<string, string>,
  warn: (message: string) => void,
): void {
  for (const id of EMAIL_CASE_IDS) {
    const def = getEmailCase(id);
    const keys = [def.keys.subject, def.keys.body, def.keys.cta].filter(
      (k): k is string => Boolean(k),
    );
    for (const key of keys) {
      const value = entries.get(key);
      if (!value) continue;
      for (const m of value.matchAll(TOKEN_RE)) {
        if (!(m[1] in def.tokens)) {
          warn(
            `email messages: "${key}" references unknown placeholder {{${m[1]}}} — it will appear in the email as literal text`,
          );
        }
      }
    }
  }
}

export function loadEmailMessages(opts: {
  defaultsText: string;
  overrideText?: string | null;
  warn?: (message: string) => void;
}): EmailMessages {
  const warn = opts.warn ?? ((message: string) => console.warn(message));

  const defaults = parseProperties(opts.defaultsText);
  const required = requiredMessageKeys();
  const missing = required.filter((k) => !defaults.entries.has(k));
  if (missing.length > 0) {
    // A hole in the bundled file is a build defect, not an ops condition.
    throw new Error(
      `bundled email messages file is missing required keys: ${missing.join(', ')}`,
    );
  }

  const merged = new Map(defaults.entries);

  if (opts.overrideText != null) {
    const override = parseProperties(opts.overrideText);
    for (const line of override.malformedLines) {
      warn(`email messages override: line ${line} is not "key=value" — ignored`);
    }
    const known = new Set(required);
    for (const [key, value] of override.entries) {
      if (!known.has(key)) {
        warn(`email messages override: unknown key "${key}" — ignored (typo?)`);
        continue;
      }
      merged.set(key, value);
    }
    const overridden = [...override.entries.keys()].filter((k) => known.has(k));
    const fellBack = required.filter((k) => !override.entries.has(k));
    warn(
      `email messages override loaded: ${overridden.length} keys overridden, ${fellBack.length} keys using bundled defaults`,
    );
  }

  lintPlaceholders(merged, warn);

  return {
    get(key: string): string {
      const value = merged.get(key);
      if (value === undefined) throw new Error(`unknown email message key: ${key}`);
      return value;
    },
  };
}

// Resolves next to this module: apps/api/src in dev (tsx/vitest), dist/ in the
// tsup bundle — tsup's onSuccess copies the file there (see tsup.config.ts).
const DEFAULTS_URL = new URL('./messages.default.properties', import.meta.url);

let messagesPromise: Promise<EmailMessages> | null = null;

export function getEmailMessages(): Promise<EmailMessages> {
  if (messagesPromise) return messagesPromise;
  messagesPromise = (async () => {
    const defaultsText = await readFile(DEFAULTS_URL, 'utf8');
    let overrideText: string | null = null;
    const overridePath = notification.EMAIL_MESSAGES_PATH;
    if (overridePath) {
      try {
        overrideText = await readFile(overridePath, 'utf8');
      } catch (err) {
        console.warn(
          `email messages: cannot read EMAIL_MESSAGES_PATH "${overridePath}" (${String(err)}) — using bundled defaults`,
        );
      }
    }
    return loadEmailMessages({ defaultsText, overrideText });
  })();
  return messagesPromise;
}

/** Test-only: drop the singleton so the next call re-reads config + files. */
export function resetEmailMessagesForTests(): void {
  messagesPromise = null;
}
```

- [ ] **Step 4: Add the env var (two-places rule) and dist packaging**

In `packages/config/src/secrets.ts`, inside `NotificationSecretsSchema` directly after the `SUPPORT_CC_EMAIL` entry:

```ts
  // Path to a mounted override of the bundled email messages file (#529).
  // Unset = bundled defaults only. A bad/missing file at this path never
  // breaks email — the loader falls back per key with warnings.
  EMAIL_MESSAGES_PATH: z.string().optional(),
```

In `turbo.json`, add `"EMAIL_MESSAGES_PATH",` to the global `env` array (it sits alphabetically after `"DATABASE_*"`-style entries near `"FRONTEND_BASE_URL"` at line 22 — the existing `"NOTIFICATION_*"` wildcard does NOT match this name).

In `apps/api/tsup.config.ts`, add to the `defineConfig({ ... })` object (after `dts: false,`):

```ts
  // The email messages defaults are read at runtime relative to the bundle
  // (import.meta.url), so ship the file next to dist/server.js (#529).
  onSuccess:
    'cp src/notifications/email/messages.default.properties dist/messages.default.properties',
```

- [ ] **Step 5: Run tests + typecheck + build to verify**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/messages.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: clean.
Run: `pnpm --filter api build && ls apps/api/dist/messages.default.properties`
Expected: the file exists in `dist/`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications/email/ packages/config/src/secrets.ts turbo.json apps/api/tsup.config.ts
git commit -m "feat(api): boot-time email messages loader with per-key ConfigMap fallback (#529)"
```

---

### Task 7: The email sender (`dispatchEmail`)

**Files:**
- Create: `apps/api/src/notifications/email/dispatch_email.ts`
- Test: `apps/api/src/notifications/email/__tests__/dispatch_email.test.ts`

**Interfaces:**
- Consumes: `getEmailCase`, `loadEmailMessages`/`getEmailMessages`, `substituteHtml`/`substitutePlain`, shells, `resolveBrandColor` from `../brand`, `getNotificationClient` from `@/utils/notificationClient`, `notification` from `@/config`.
- Produces (every later task migrates onto these):

```ts
export interface EmailNotifyRequest {
  channel: 'email';
  template_id: 'basic_email';
  to: string;
  priority: 'realtime' | 'other';
  dedupe_id?: string;
  variables: {
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    html: string;
    cc?: string;
  };
}

export interface DispatchEmailArgs {
  caseId: string;
  to: string;
  /** From-name shown to the recipient (brand, "<X> Support", "Welcome to <X>", …). */
  fromName: string;
  variables?: Record<string, string>;
  dedupeId?: string;
  replyTo?: string;
  cc?: string;
  /** cta-shell cases only: */
  ctaUrl?: string;
  network?: string;
  /** Sign-off name in the cta shell; defaults to fromName. */
  brandName?: string;
  /** Per-call log override (route handlers pass request.log-backed fns). */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EmailSender {
  dispatchEmail(args: DispatchEmailArgs): Promise<{ ok: boolean }>;
}

export interface EmailSenderDeps {
  notify: (req: EmailNotifyRequest) => Promise<unknown>;
  getMessages: () => Promise<EmailMessages>;
  fromEmail: string;
  defaultReplyTo: string;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export function createEmailSender(deps: EmailSenderDeps): EmailSender;
/** Memoised sender from env config; null when no notification client. */
export function getDefaultEmailSender(): EmailSender | null;
export function resetDefaultEmailSenderForTests(): void;
export const DEFAULT_FROM_EMAIL = 'hello@bluedotseconomy.org';
```

Behaviour contract:
1. `subject = oneLine(substitutePlain(messages.get(keys.subject), vars, tokens))` — `oneLine` collapses `\s+` to single spaces (generalizes the support header-injection guard to all subjects).
2. `bodyHtml = substituteHtml(messages.get(keys.body), vars, tokens)`.
3. **otpBox auto-derivation:** if the case declares `otpBox: 'html'` and `vars.otp` is set and `vars.otpBox` is not, set `vars.otpBox = renderOtpBox(vars.otp)` before substitution. (Keeps the styled fragment code-built even when the caller is `packages/auth`.)
4. Shell: `cta` → `renderCtaShell({ introHtml: bodyHtml, ctaUrl: args.ctaUrl ?? '', ctaLabel: substitutePlain(messages.get(keys.cta!), vars, tokens), ctaColor: resolveBrandColor(args.network), brandName: args.brandName ?? args.fromName })`; `plain` → `renderPlainShell(bodyHtml)`.
5. Send with `priority` from the registry, `fromEmail`/`replyTo ?? defaultReplyTo` from deps, `cc` only when provided.
6. Whole flow wrapped: on any error, `critical` → rethrow; `best_effort` → `log('email dispatch failed', { err, caseId })` and return `{ ok: false }`.
7. `getDefaultEmailSender()`: `null` if `getNotificationClient()` is null; else memoised `createEmailSender` with `fromEmail = notification.NOTIFICATION_FROM_EMAIL ?? DEFAULT_FROM_EMAIL` (the fallback preserves today's hardcoded auth-email sender when `NOTIFICATION_FROM_EMAIL` is unset), `defaultReplyTo = notification.NOTIFICATION_REPLY_TO ?? fromEmail`, `getMessages = getEmailMessages`, `log = (m, meta) => console.warn(m, meta ?? {})`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/notifications/email/__tests__/dispatch_email.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createEmailSender } from '../dispatch_email';
import { loadEmailMessages } from '../messages';
import { requiredMessageKeys } from '../email_cases';

function messagesWith(overrides: Record<string, string>) {
  const defaults = requiredMessageKeys()
    .map((k) => `${k}=[${k}]`)
    .join('\n');
  const overrideText = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const m = loadEmailMessages({ defaultsText: defaults, overrideText, warn: () => {} });
  return () => Promise.resolve(m);
}

function makeSender(overrides: Record<string, string> = {}) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const sender = createEmailSender({
    notify,
    getMessages: messagesWith(overrides),
    fromEmail: 'noreply@x.example',
    defaultReplyTo: 'reply@x.example',
    log,
  });
  return { sender, notify, log };
}

describe('dispatchEmail', () => {
  it('renders copy + escaped variables into the plain shell and sends', async () => {
    const { sender, notify } = makeSender({
      'welcome.subject': 'Welcome to {{appName}}!',
      'welcome.body': '<p>Hello {{userName}}</p>',
    });
    const res = await sender.dispatchEmail({
      caseId: 'welcome',
      to: 'u@x.example',
      fromName: 'Welcome to Blue Dot',
      variables: { userName: '<b>Anu</b>', appName: 'Blue Dot' },
    });
    expect(res.ok).toBe(true);
    const req = notify.mock.calls[0][0];
    expect(req.template_id).toBe('basic_email');
    expect(req.priority).toBe('realtime');
    expect(req.variables.subject).toBe('Welcome to Blue Dot!');
    expect(req.variables.html).toContain('Hello &lt;b&gt;Anu&lt;/b&gt;');
    expect(req.variables.fromEmail).toBe('noreply@x.example');
    expect(req.variables.replyTo).toBe('reply@x.example');
  });

  it('auto-builds the otpBox html token from vars.otp', async () => {
    const { sender, notify } = makeSender({
      'login.otp.body': '{{otpBox}}',
    });
    await sender.dispatchEmail({
      caseId: 'login.otp',
      to: 'u@x.example',
      fromName: 'Blue Dot',
      variables: { otp: '123456' },
    });
    const html = notify.mock.calls[0][0].variables.html;
    expect(html).toContain('123456');
    expect(html).toContain('Courier New');
  });

  it('renders the cta shell with label from copy and network colour', async () => {
    const { sender, notify } = makeSender({
      'retire.cancel.body': '<p>gone</p>',
      'retire.cancel.cta': 'See connections',
    });
    await sender.dispatchEmail({
      caseId: 'retire.cancel',
      to: 'u@x.example',
      fromName: 'Blue Dot',
      network: 'blue_dot',
      ctaUrl: 'https://ui.example/auth/login',
      dedupeId: 'retire_cancel:a1:u1',
    });
    const req = notify.mock.calls[0][0];
    expect(req.priority).toBe('other');
    expect(req.dedupe_id).toBe('retire_cancel:a1:u1');
    expect(req.variables.html).toContain('See connections');
    expect(req.variables.html).toContain('https://ui.example/auth/login');
    expect(req.variables.html).toContain('#2563eb');
  });

  it('flattens newlines out of subjects (header-injection guard)', async () => {
    const { sender, notify } = makeSender({
      'support.request.subject': 'Issue {{reference}} — {{name}}',
    });
    await sender.dispatchEmail({
      caseId: 'support.request',
      to: 's@x.example',
      fromName: 'X Support',
      variables: { reference: 'SUP-1', name: 'a\r\nBcc: evil@x', detailsTable: '<table></table>' },
    });
    expect(notify.mock.calls[0][0].variables.subject).toBe('Issue SUP-1 — a Bcc: evil@x');
  });

  it('critical case: rethrows send failures', async () => {
    const { sender, notify } = makeSender();
    notify.mockRejectedValue(new Error('boom'));
    await expect(
      sender.dispatchEmail({
        caseId: 'login.otp',
        to: 'u@x.example',
        fromName: 'X',
        variables: { otp: '1' },
      }),
    ).rejects.toThrow('boom');
  });

  it('best-effort case: logs and returns ok:false, never throws', async () => {
    const { sender, notify, log } = makeSender();
    notify.mockRejectedValue(new Error('boom'));
    const res = await sender.dispatchEmail({
      caseId: 'welcome',
      to: 'u@x.example',
      fromName: 'X',
      variables: {},
    });
    expect(res.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'email dispatch failed',
      expect.objectContaining({ caseId: 'welcome' }),
    );
  });

  it('passes cc through only when set', async () => {
    const { sender, notify } = makeSender();
    await sender.dispatchEmail({
      caseId: 'support.request',
      to: 's@x.example',
      fromName: 'X Support',
      cc: 'cc@x.example',
      variables: { detailsTable: '<table></table>' },
    });
    expect(notify.mock.calls[0][0].variables.cc).toBe('cc@x.example');
    await sender.dispatchEmail({
      caseId: 'welcome',
      to: 'u@x.example',
      fromName: 'X',
      variables: {},
    });
    expect(notify.mock.calls[1][0].variables).not.toHaveProperty('cc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/dispatch_email.test.ts`
Expected: FAIL — cannot resolve `../dispatch_email`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/notifications/email/dispatch_email.ts
import { notification } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { resolveBrandColor } from '../brand';
import { getEmailCase } from './email_cases';
import { getEmailMessages } from './messages';
import type { EmailMessages } from './messages';
import { renderCtaShell, renderOtpBox, renderPlainShell } from './shells';
import { substituteHtml, substitutePlain } from './substitute';

/**
 * The single email send path (#529): copy lookup → token substitution
 * (escaping boundary) → HTML shell → notification service. Criticality comes
 * from the case registry: critical sends rethrow so the caller can surface
 * delivery failure (OTP 502s, support 502); best-effort sends never throw —
 * an email failure must never block the action that triggered it.
 */
export interface EmailNotifyRequest {
  channel: 'email';
  template_id: 'basic_email';
  to: string;
  priority: 'realtime' | 'other';
  dedupe_id?: string;
  variables: {
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    html: string;
    cc?: string;
  };
}

export interface DispatchEmailArgs {
  caseId: string;
  to: string;
  fromName: string;
  variables?: Record<string, string>;
  dedupeId?: string;
  replyTo?: string;
  cc?: string;
  ctaUrl?: string;
  network?: string;
  brandName?: string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EmailSender {
  dispatchEmail(args: DispatchEmailArgs): Promise<{ ok: boolean }>;
}

export interface EmailSenderDeps {
  notify: (req: EmailNotifyRequest) => Promise<unknown>;
  getMessages: () => Promise<EmailMessages>;
  fromEmail: string;
  defaultReplyTo: string;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

/** Collapse CR/LF/tabs so a substituted subject can't inject email headers. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function createEmailSender(deps: EmailSenderDeps): EmailSender {
  async function send(args: DispatchEmailArgs): Promise<void> {
    const def = getEmailCase(args.caseId);
    const messages = await deps.getMessages();

    const vars: Record<string, string> = { ...(args.variables ?? {}) };
    // The styled OTP box is code-built (html token) even when the caller —
    // e.g. packages/auth — only knows the plain code.
    if (def.tokens.otpBox === 'html' && vars.otp !== undefined && vars.otpBox === undefined) {
      vars.otpBox = renderOtpBox(vars.otp);
    }

    const subject = oneLine(
      substitutePlain(messages.get(def.keys.subject), vars, def.tokens),
    );
    const bodyHtml = substituteHtml(messages.get(def.keys.body), vars, def.tokens);

    const html =
      def.shell === 'cta'
        ? renderCtaShell({
            introHtml: bodyHtml,
            ctaUrl: args.ctaUrl ?? '',
            ctaLabel: substitutePlain(
              messages.get(def.keys.cta as string),
              vars,
              def.tokens,
            ),
            ctaColor: resolveBrandColor(args.network),
            brandName: args.brandName ?? args.fromName,
          })
        : renderPlainShell(bodyHtml);

    await deps.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: args.to,
      priority: def.priority,
      ...(args.dedupeId ? { dedupe_id: args.dedupeId } : {}),
      variables: {
        fromName: args.fromName,
        fromEmail: deps.fromEmail,
        replyTo: args.replyTo ?? deps.defaultReplyTo,
        subject,
        html,
        ...(args.cc ? { cc: args.cc } : {}),
      },
    });
  }

  return {
    async dispatchEmail(args: DispatchEmailArgs): Promise<{ ok: boolean }> {
      const log = args.log ?? deps.log;
      try {
        await send(args);
        return { ok: true };
      } catch (err) {
        if (getEmailCase(args.caseId).criticality === 'critical') throw err;
        log('email dispatch failed', { err, caseId: args.caseId });
        return { ok: false };
      }
    },
  };
}

/**
 * Preserves the previously-hardcoded auth-email sender when
 * NOTIFICATION_FROM_EMAIL is unset, so no config permutation loses email.
 */
export const DEFAULT_FROM_EMAIL = 'hello@bluedotseconomy.org';

let defaultSender: EmailSender | null | undefined;

export function getDefaultEmailSender(): EmailSender | null {
  if (defaultSender !== undefined) return defaultSender;
  const nc = getNotificationClient();
  if (!nc) {
    defaultSender = null;
    return defaultSender;
  }
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL ?? DEFAULT_FROM_EMAIL;
  defaultSender = createEmailSender({
    notify: (req) => nc.notify(req),
    getMessages: getEmailMessages,
    fromEmail,
    defaultReplyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
    log: (message, meta) => console.warn(message, meta ?? {}),
  });
  return defaultSender;
}

export function resetDefaultEmailSenderForTests(): void {
  defaultSender = undefined;
}
```

Note: the `getEmailCase(args.caseId).criticality` call in the catch also throws for an unknown caseId — that error propagates either way, which is correct (an unknown case is a programming error, not a send failure). If the first `getEmailCase` call in `send()` threw, we reach the catch with the same error; calling it again rethrows identically. Acceptable.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/notifications/email/__tests__/dispatch_email.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/email/
git commit -m "feat(api): dispatchEmail sender with per-case criticality + shells (#529)"
```

---

### Task 8: Migrate action + retire emails

**Files:**
- Modify: `apps/api/src/notifications/action_copy.ts` (delete `COPY`, `resolveActionEmailCopy`, `ActionEmailCopy`, `RETIRE_CANCEL_COPY`; keep `resolveCopyGroup`, `resolveRecipientRole`, `PROVIDER_LIKE_DOMAINS`, `FALLBACK_SERVICE_NAME`, `CopyGroup`, `RecipientRole`)
- Delete: `apps/api/src/notifications/render_action_email.ts`
- Modify: `apps/api/src/notifications/dispatcher.ts`
- Modify: `apps/api/src/notifications/notify_actions.ts`
- Modify: `apps/api/src/notifications/notify_retire.ts`
- Tests: update `apps/api/src/notifications/__tests__/{action_copy,dispatcher,notify_retire}.test.ts`; delete `render_action_email.test.ts`; check `apps/api/src/__tests__/small_misc_group.test.ts` for references.

**Interfaces:**
- Consumes: `actionCaseId`, `EmailSender`/`DispatchEmailArgs`/`EmailNotifyRequest`, `createEmailSender` from Task 7; existing `buildNotifications`, `resolveOwnerEmail`, `resolveProviderServiceName`, `buildCtaUrl`, `resolveNetworkBrandName`.
- Produces: `DispatcherDeps` changes — `notify` is REPLACED by `sendEmail: (args: DispatchEmailArgs) => Promise<{ ok: boolean }>`, and `brand` shrinks to `{ brandName: string; ctaUrl: string }` (fromEmail/replyTo now live in the sender). `NotifierConfig` in `notify_actions.ts` gains `sender: EmailSender` and drops `notify`.

- [ ] **Step 1: Rewrite `dispatcher.ts`**

```ts
// apps/api/src/notifications/dispatcher.ts
import { buildNotifications } from './build_notifications';
import type { NotificationEvent, NotificationPlan } from './build_notifications';
import type { DispatchEmailArgs } from './email/dispatch_email';
import {
  FALLBACK_SERVICE_NAME,
  resolveCopyGroup,
  resolveRecipientRole,
} from './action_copy';
import { actionCaseId } from './email/email_cases';

export interface DispatcherDeps {
  /** Sends one rendered email (the central email sender, #529). */
  sendEmail: (args: DispatchEmailArgs) => Promise<{ ok: boolean }>;
  /** Resolves a local owner's email by user id; null when unknown/phone-only. */
  resolveEmail: (userId: string) => Promise<string | null>;
  /**
   * Resolves the counterparty's service name for `{{name}}` in seeker-facing
   * copy (the provider's Service Name); null for provider-facing copy.
   */
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  brand: {
    brandName: string;
    ctaUrl: string;
  };
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** Visibility hook for skipped (dark) recipients. */
  onSkip: (reason: string) => void;
}

export interface DirectDispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>;
}

/**
 * Resolves recipients and hands each plan to the central email sender.
 * Fire-and-forget by contract: a failure for any plan is logged and never
 * propagates, so it can never fail or slow the action route. The Phase-2
 * transport (Kafka/registry) swaps in behind this same interface.
 */
export function createDirectDispatcher(deps: DispatcherDeps): DirectDispatcher {
  async function dispatchPlan(plan: NotificationPlan): Promise<void> {
    if (!plan.recipientUserId) {
      deps.onSkip('no_user_id');
      deps.log('notification skipped: owner has no user id', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    const email = await deps.resolveEmail(plan.recipientUserId);
    if (!email) {
      deps.onSkip('no_email');
      deps.log('notification skipped: owner has no email', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    const counterpartyName = await deps.resolveCounterpartyName(plan);

    await deps.sendEmail({
      caseId: actionCaseId(
        resolveCopyGroup(plan.actionType),
        resolveRecipientRole(plan.recipientDomain),
        plan.shape,
      ),
      to: email,
      fromName: deps.brand.brandName,
      brandName: deps.brand.brandName,
      network: plan.counterpartyNetwork,
      ctaUrl: deps.brand.ctaUrl,
      dedupeId: `${plan.actionId}:${plan.updateCount}:${plan.shape}`,
      variables: { name: counterpartyName?.trim() || FALLBACK_SERVICE_NAME },
      log: deps.log,
    });
  }

  return {
    async dispatch(event: NotificationEvent): Promise<void> {
      const plans = buildNotifications(event);
      for (const plan of plans) {
        try {
          await dispatchPlan(plan);
        } catch (err) {
          deps.log('notification dispatch failed', {
            err,
            shape: plan.shape,
            actionId: plan.actionId,
          });
        }
      }
    },
  };
}
```

- [ ] **Step 2: Slim `action_copy.ts`**

Keep only: the module doc comment (trim its copy-table references), `CopyGroup`, `RecipientRole`, `resolveCopyGroup`, `PROVIDER_LIKE_DOMAINS`, `resolveRecipientRole`, `FALLBACK_SERVICE_NAME`. Delete `ActionEmailCopy`, `COPY`, `resolveActionEmailCopy`, `RETIRE_CANCEL_COPY`, and the now-unused `import type { NotificationShape }`. The copy now lives in `messages.default.properties` (Task 5) — add one line to the doc comment saying so.

- [ ] **Step 3: Delete `render_action_email.ts` and update `notify_actions.ts`**

`git rm apps/api/src/notifications/render_action_email.ts` (its cta shell moved to `email/shells.ts` in Task 4; its lookup+substitution is now `dispatchEmail`).

In `notify_actions.ts`:
- Replace the `NotifierConfig` interface and `resolveNotifierConfig` body:

```ts
import { createEmailSender } from './email/dispatch_email';
import type { EmailSender } from './email/dispatch_email';
import { getEmailMessages } from './email/messages';

export interface NotifierConfig {
  sender: EmailSender;
  ctaUrl: string;
}

// `undefined` = not yet resolved; `null` = resolved and not configured.
let cachedConfig: NotifierConfig | null | undefined;

/**
 * Memoised notifier config (email sender + cta). `null` when notifications
 * aren't configured. Shared with the retire notifier (#418) so both read the
 * same config + reset. Action emails stay gated on an explicit
 * NOTIFICATION_FROM_EMAIL + FRONTEND_BASE_URL (unchanged from before #529).
 */
export function resolveNotifierConfig(): NotifierConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const nc = getNotificationClient();
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL;
  const frontendBaseUrl = notification.FRONTEND_BASE_URL;

  if (!nc || !fromEmail || !frontendBaseUrl) {
    cachedConfig = null;
    return cachedConfig;
  }

  cachedConfig = {
    sender: createEmailSender({
      notify: (req) => nc.notify(req),
      getMessages: getEmailMessages,
      fromEmail,
      defaultReplyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
      log: (message, meta) => console.warn(message, meta ?? {}),
    }),
    ctaUrl: buildCtaUrl(frontendBaseUrl),
  };
  return cachedConfig;
}
```

- In `dispatchActionNotifications`, the `createDirectDispatcher` call becomes:

```ts
  const dispatcher = createDirectDispatcher({
    sendEmail: (args) => config.sender.dispatchEmail(args),
    resolveEmail: resolveOwnerEmail,
    resolveCounterpartyName: async (plan: NotificationPlan) =>
      resolveRecipientRole(plan.counterpartyDomain) === 'provider'
        ? resolveProviderServiceName(plan.counterpartyItemId, plan.counterpartyNetwork)
        : null,
    brand: { brandName, ctaUrl: config.ctaUrl },
    log: (message, meta) => log.warn(meta ?? {}, message),
    onSkip: (reason) => log.info({ reason }, 'action notification skipped'),
  });
```

(The existing comment block above `resolveCounterpartyName` stays.)

- [ ] **Step 4: Update `notify_retire.ts`**

Replace the render+notify block (lines 48-67) with:

```ts
      await config.sender.dispatchEmail({
        caseId: 'retire.cancel',
        to: email,
        fromName: brandName,
        brandName,
        network: cp.network,
        ctaUrl: config.ctaUrl,
        dedupeId: `retire_cancel:${cp.actionId}:${cp.ownerUserId}`,
        log: (message, meta) => log.warn(meta ?? {}, message),
      });
```

Remove the `renderRetireCancelEmail` import. Keep the dedupe `seen` set, the try/catch, and everything else.

- [ ] **Step 5: Migrate the tests**

Run `pnpm --filter api test` and fix, using this mapping:

| Old reference | Replacement |
|---|---|
| `resolveActionEmailCopy(g, r, s).subject/body/ctaLabel` assertions in `action_copy.test.ts` | Move the copy-content assertions into `messages_default.test.ts`-style lookups (`entries.get('action.<g>.<r>.<lowercase s>.subject')`); keep `resolveCopyGroup`/`resolveRecipientRole` tests as-is. |
| `render_action_email.test.ts` (subject `{name}` substitution, body escaping, CTA/link/brand assertions) | Delete the file — equivalent coverage exists in `dispatch_email.test.ts` (escaping, cta shell) and `shells.test.ts`. If it has an assertion not covered (e.g. `{name}` fallback to `FALLBACK_SERVICE_NAME`), add a dispatcher test: build `createDirectDispatcher` with a `sendEmail` spy, `resolveCounterpartyName: async () => null`, and assert `variables.name === 'the service provider'`. |
| `dispatcher.test.ts` `deps.notify` mock + assertions on `req.variables.subject/html`, `template_id` | Mock `sendEmail: vi.fn().mockResolvedValue({ ok: true })`; assert on `caseId`, `to`, `dedupeId`, `variables.name` instead of rendered HTML. |
| `notify_retire.test.ts` mocks of `resolveNotifierConfig`/`notify` | Config mock now returns `{ sender: { dispatchEmail: spy }, ctaUrl }`; assert `caseId: 'retire.cancel'` + `dedupeId`. |
| `small_misc_group.test.ts` | Grep it for `action_copy`/`render_action_email` imports; update per the same mapping (it currently matched a repo-wide grep for these names). |

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter api test && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/notifications apps/api/src/__tests__
git commit -m "refactor(api): action + retire emails through central dispatchEmail (#529)"
```

---

### Task 9: Migrate the support email

**Files:**
- Modify: `apps/api/src/support/build_support_email.ts`
- Modify: `apps/api/src/routes/v1/support/submit_support.ts`
- Tests: update `apps/api/src/support/__tests__/build_support_email.test.ts`; check `apps/api/src/__tests__/misc_handlers_group.test.ts` for support-route assertions.

**Interfaces:**
- Consumes: `getDefaultEmailSender` from Task 7.
- Produces: `build_support_email.ts` exports become `generateSupportReference` (unchanged), `TYPE_LABELS` (now exported), and `buildSupportDetailsTable(input: { reference: string; name: string; email: string | null; phone: string | null; submittedAt: string }): string` — the escaped contact-details `<table>` html token (rows: Reference, Name, Phone, Email, Submitted at, Consent to share contact=Yes, `—` for null contact fields, exactly as today). Delete `buildSupportEmail`, `SupportEmail`, `oneLine`, `escapeHtml` (subject flattening is now central in `dispatchEmail`; escaping comes from `email/substitute.ts`).

- [ ] **Step 1: Rewrite `build_support_email.ts`'s builder**

Keep the file header comment, `SupportType`, `TYPE_LABELS` (add `export`), reference constants, `generateSupportReference`. Replace `buildSupportEmail` with:

```ts
import { escapeHtml } from '@/notifications/email/substitute';

/**
 * Builds the escaped contact-details table for the support email — the
 * `{{detailsTable}}` html token (#529). Pure; all user-controlled strings are
 * HTML-escaped here, which is what licenses inserting the result raw.
 */
export function buildSupportDetailsTable(input: {
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  submittedAt: string;
}): string {
  const rows: Array<[string, string]> = [
    ['Reference', input.reference],
    ['Name', input.name],
    ['Phone', input.phone ?? '—'],
    ['Email', input.email ?? '—'],
    ['Submitted at', input.submittedAt],
    ['Consent to share contact', 'Yes'],
  ];
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<p style="margin:0 0 4px;font-weight:600">Contact details</p><table style="border-collapse:collapse;font-size:13px">${detailRows}</table>`;
}
```

- [ ] **Step 2: Update `submit_support.ts`**

Replace the `buildSupportEmail` + `nc.notify` block (lines 80-112) with:

```ts
  const sender = getDefaultEmailSender();
  if (!supportConfig.recipients || !supportConfig.fromEmail || !sender) {
    return reply.code(503).send({
      error: 'SUPPORT_NOT_CONFIGURED',
      message: 'Support is not configured on this instance.',
    });
  }
  // …(user-row existence check stays here, unchanged)…

  const reference = generateSupportReference(new Date());
  const teamName = supportConfig.teamName ?? 'Support';

  try {
    await sender.dispatchEmail({
      caseId: 'support.request',
      to: supportConfig.recipients,
      fromName: `${instance.INSTANCE_NAME ?? 'DPG'} Support`,
      replyTo: submittedEmail ?? supportConfig.fromEmail,
      ...(supportConfig.cc ? { cc: supportConfig.cc } : {}),
      // Per-submission dedupe key. Without it the notification-service falls
      // back to `${channel}:${to}:${template_id}` (constant per instance), so
      // two submissions to the same inbox within its dedupe TTL collapse and
      // the second is silently dropped. The unique reference closes that.
      dedupeId: reference,
      variables: {
        reference,
        type: TYPE_LABELS[type],
        name,
        fromSite: supportConfig.linkBaseUrl ? ` from ${supportConfig.linkBaseUrl}` : '',
        details,
        teamName,
        detailsTable: buildSupportDetailsTable({
          reference,
          name,
          email: submittedEmail ?? null,
          phone: submittedPhone ?? null,
          submittedAt: new Date().toISOString(),
        }),
      },
      log: (message, meta) => request.log.warn(meta ?? {}, message),
    });
  } catch (err) {
    request.log.error({ err }, 'support email send failed');
    return reply.code(502).send({
      error: 'SUPPORT_SEND_FAILED',
      message: 'Failed to send your message. Please try again later.',
    });
  }
```

Update imports: drop `getNotificationClient`/`buildSupportEmail`, add `getDefaultEmailSender`, `TYPE_LABELS`, `buildSupportDetailsTable`. The original 503-gate at lines 59-65 is replaced by the sender-based gate above (same status/shape; `getDefaultEmailSender()` is null exactly when `getNotificationClient()` is).

- [ ] **Step 3: Migrate tests**

`build_support_email.test.ts`: keep `generateSupportReference` tests; replace `buildSupportEmail` subject/html assertions with `buildSupportDetailsTable` assertions (escaping of name/email, `—` for missing phone). Subject-injection coverage now lives in `dispatch_email.test.ts` ("flattens newlines"). `misc_handlers_group.test.ts`: if it exercises `POST /support`, update its notify-client mock to a `getDefaultEmailSender` mock (`vi.mock('@/notifications/email/dispatch_email', ...)` returning a `dispatchEmail` spy) and assert `caseId`/`dedupeId`/`replyTo` instead of raw HTML.

- [ ] **Step 4: Run suite + typecheck**

Run: `pnpm --filter api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src/support apps/api/src/routes/v1/support apps/api/src/__tests__
git commit -m "refactor(api): support email through central dispatchEmail (#529)"
```

---

### Task 10: Migrate the guardian OTP email

**Files:**
- Modify: `apps/api/src/services/guardian_otp.ts` (the `defaultGuardianOtpSend` email branch, lines 214-243)
- Delete: `apps/api/src/services/guardian_otp_email.ts`
- Tests: update guardian-email assertions in `apps/api/src/__tests__/misc_handlers_group.test.ts`; add `apps/api/src/services/__tests__/guardian_otp_dispatch.test.ts` for the new pure mapper.

**Interfaces:**
- Consumes: `getDefaultEmailSender`, `renderOrgList`.
- Produces: `buildGuardianEmailDispatch(args: { scenario?: GuardianOtpScenario; otp: string; variables: GuardianOtpVariables; teamName: string }): { caseId: string; variables: Record<string, string> }` — exported from `guardian_otp.ts` for direct unit testing.

- [ ] **Step 1: Write the failing test for the mapper**

```ts
// apps/api/src/services/__tests__/guardian_otp_dispatch.test.ts
import { describe, expect, it } from 'vitest';
import { buildGuardianEmailDispatch } from '../guardian_otp';

describe('buildGuardianEmailDispatch', () => {
  it('maps a scenario-less send to otp.generic', () => {
    const d = buildGuardianEmailDispatch({ otp: '123456', variables: {}, teamName: 'Blue Dot' });
    expect(d.caseId).toBe('otp.generic');
    expect(d.variables.otp).toBe('123456');
  });

  it('maps scenario kinds to guardian.* cases with fallback values', () => {
    const d = buildGuardianEmailDispatch({
      scenario: { kind: 'account' },
      otp: '111111',
      variables: {},
      teamName: 'Blue Dot',
    });
    expect(d.caseId).toBe('guardian.account');
    expect(d.variables).toMatchObject({
      otp: '111111',
      parentName: 'there',
      domain: 'Blue Dot', // falls back to teamName (copy has no conditionals)
      org: 'the organisation',
      teamName: 'Blue Dot',
    });
  });

  it('passes through provided parentName/domain/org', () => {
    const d = buildGuardianEmailDispatch({
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      otp: '1',
      variables: { parentName: 'Ravi', domain: 'yellow.example', providerOrgName: 'Acme' },
      teamName: 'X',
    });
    expect(d.variables.parentName).toBe('Ravi');
    expect(d.variables.org).toBe('Acme');
  });

  it('builds noun + escaped orgList for action_bulk', () => {
    const d = buildGuardianEmailDispatch({
      scenario: {
        kind: 'action_bulk',
        actionType: 'apply',
        stage: 'initiate',
        providerOrgNames: ['A&B', 'C'],
        jobs: true,
      },
      otp: '1',
      variables: {},
      teamName: 'X',
    });
    expect(d.caseId).toBe('guardian.action_bulk');
    expect(d.variables.noun).toBe('jobs');
    expect(d.variables.orgList).toBe('<ol><li>A&amp;B</li><li>C</li></ol>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp_dispatch.test.ts`
Expected: FAIL — `buildGuardianEmailDispatch` is not exported.

- [ ] **Step 3: Implement in `guardian_otp.ts`**

Add the two imports to the import block at the top of the file, and the function just above `defaultGuardianOtpSend`:

```ts
// top of file, with the other imports:
import { renderOrgList } from '@/notifications/email/shells';
import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';

/**
 * Maps a guardian OTP scenario to its email case + variables (#529). Pure —
 * fallback values are supplied here because the copy file has no
 * conditionals: every declared placeholder always gets a value.
 */
export function buildGuardianEmailDispatch(args: {
  scenario?: GuardianOtpScenario;
  otp: string;
  variables: GuardianOtpVariables;
  teamName: string;
}): { caseId: string; variables: Record<string, string> } {
  const { scenario, otp, variables, teamName } = args;
  if (!scenario) {
    return { caseId: 'otp.generic', variables: { otp } };
  }
  const vars: Record<string, string> = {
    otp,
    parentName: variables.parentName || 'there',
    domain: variables.domain || teamName,
    org: variables.providerOrgName || 'the organisation',
    teamName,
  };
  if (scenario.kind === 'action_bulk') {
    vars.noun = scenario.jobs ? 'jobs' : 'opportunities';
    vars.orgList = renderOrgList(scenario.providerOrgNames);
  }
  return { caseId: `guardian.${scenario.kind}`, variables: vars };
}
```

Then replace the email branch of `defaultGuardianOtpSend` (the `if (channel === 'email') { ... }` block) with:

```ts
  if (channel === 'email') {
    const sender = getDefaultEmailSender();
    if (!sender) {
      throw new GuardianOtpError('NO_OTP_PROVIDER');
    }
    const teamName = supportConfig.teamName ?? 'Blue Dots';
    const dispatch = buildGuardianEmailDispatch({
      scenario,
      otp,
      variables: variables ?? {},
      teamName,
    });
    // Critical case: dispatchEmail rethrows on failure, so a lost guardian
    // OTP surfaces to the caller exactly as the direct notify() did.
    await sender.dispatchEmail({
      caseId: dispatch.caseId,
      to: contact,
      fromName: teamName,
      variables: dispatch.variables,
    });
    return;
  }
```

Remove the `renderGuardianOtpEmail` import; the SMS branch and the existing `const client = getNotificationClient(); if (!client) throw ...` prologue stay exactly as they are (SMS still needs the raw client). Then `git rm apps/api/src/services/guardian_otp_email.ts`.

- [ ] **Step 4: Migrate existing guardian-email tests**

`misc_handlers_group.test.ts` (it references `guardian_otp_email`): replace `renderGuardianOtpEmail` render assertions with `buildGuardianEmailDispatch` assertions (already covered by the new test file — delete duplicated ones) and, for the send path, mock `getDefaultEmailSender`.

- [ ] **Step 5: Run suite + typecheck**

Run: `pnpm --filter api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/services apps/api/src/__tests__
git commit -m "refactor(api): guardian OTP email through central dispatchEmail (#529)"
```

---

### Task 11: Auth package — injected sendEmail (login OTP + welcome)

**Files:**
- Modify: `packages/auth/src/types.d.ts` (add `sendEmail` to `AuthRuntimeConfig`)
- Modify: `packages/auth/src/config.ts` (`sendEmailOtp`, welcome email in `afterUserCreate`)
- Delete: `packages/auth/src/templates/otp_email.ts`
- Modify: `apps/api/src/routes/auth/create_auth.ts` (wire the callback)
- Tests: delete `packages/auth/src/__tests__/otp_email_template.test.ts`; update `packages/auth/src/__tests__/config.test.ts` if it asserts on the old HTML.

**Interfaces:**
- Consumes: `getDefaultEmailSender` (apps/api side only — `packages/auth` never imports it).
- Produces: on `AuthRuntimeConfig`:

```ts
  /**
   * Central email dispatch (#529), injected by the app so copy/templates stay
   * out of this package. caseId keys into the app's email case registry.
   * When absent (no notification client / tests), the console fallback below
   * is used instead. login.otp MUST rethrow on failure (fail-loud OTP, #1.14);
   * welcome is best-effort and never throws in the app's implementation.
   */
  sendEmail?: (args: {
    caseId: 'login.otp' | 'welcome';
    to: string;
    fromName: string;
    variables: Record<string, string>;
  }) => Promise<void>;
```

- [ ] **Step 1: Add `sendEmail` to `types.d.ts`** (block above, placed after `smsTemplateId`).

- [ ] **Step 2: Rewrite the two email callbacks in `packages/auth/src/config.ts`**

`sendEmailOtp` (replace the whole callback):

```ts
        sendEmailOtp: async ({ email, otp, user }) => {
          if (config.sendEmail) {
            try {
              await config.sendEmail({
                caseId: 'login.otp',
                to: email,
                fromName: config.appName,
                variables: {
                  otp,
                  userName: user?.name?.toLowerCase() || 'user',
                  signAction: user ? 'sign in' : 'sign up',
                  appName: config.appName,
                },
              });
            } catch (err) {
              console.error('Failed to send email OTP via notification service:', err);
              // Propagate so the OTP endpoint can report the delivery failure
              // instead of returning ok:true for a code that never arrived.
              throw err;
            }
          } else {
            console.log({
              to: email,
              subject: 'Your One-Time Password',
              otp,
            });
          }
        },
```

Welcome email inside `afterUserCreate` (replace the `if (payload.user.email)` block; the WhatsApp block and the `config.afterUserCreate` hook stay untouched):

```ts
            if (payload.user.email && config.sendEmail) {
              try {
                await config.sendEmail({
                  caseId: 'welcome',
                  to: payload.user.email,
                  fromName: `Welcome to ${config.appName}`,
                  variables: {
                    userName: payload.user.name,
                    appName: config.appName,
                  },
                });
              } catch (err) {
                console.error('Failed to send welcome email:', err);
              }
            }
```

Note the surrounding `if (nc) { ... }` guard around the welcome/WhatsApp block stays (WhatsApp still needs `nc`); the welcome email now additionally checks `config.sendEmail`. Remove the `emailOtpHtmlTemplate` import, then `git rm packages/auth/src/templates/otp_email.ts` and `git rm packages/auth/src/__tests__/otp_email_template.test.ts`.

- [ ] **Step 3: Wire the callback in `apps/api/src/routes/auth/create_auth.ts`**

After the `smsTemplateId` line:

```ts
  // Central email dispatch (#529): login-OTP + welcome copy live in the email
  // messages file; criticality comes from the case registry (login.otp
  // critical → throws → OTP_DELIVERY_FAILED 502; welcome best-effort → the
  // sender swallows failures). Only wired when a notification client exists,
  // preserving the package's console fallback for local dev.
  ...(getNotificationClient()
    ? {
        sendEmail: async (args: {
          caseId: 'login.otp' | 'welcome';
          to: string;
          fromName: string;
          variables: Record<string, string>;
        }) => {
          const sender = getDefaultEmailSender();
          if (!sender) throw new Error('email sender not configured');
          await sender.dispatchEmail(args);
        },
      }
    : {}),
```

Add `import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';`.

- [ ] **Step 4: Update auth package tests**

Run the auth tests (see Global Constraints for the command). If `config.test.ts` asserts on `emailOtpHtmlTemplate` output or the welcome HTML, replace with assertions that `config.sendEmail` was called with `caseId: 'login.otp'` / `'welcome'` and the right `variables` (inject a `sendEmail` spy into `createAuth`'s config in the test). Also verify the throw-propagation branch: `sendEmail` rejecting → `sendEmailOtp` rejects.

- [ ] **Step 5: Run everything**

Run: `pnpm --filter api test && pnpm --filter auth exec vitest run && pnpm typecheck`
Expected: PASS, clean. (If the auth package has a `test` script, prefer `pnpm --filter auth test`.)

- [ ] **Step 6: Commit**

```bash
git add -A packages/auth apps/api/src/routes/auth
git commit -m "refactor(auth): login-OTP + welcome emails via injected central dispatcher (#529)"
```

---

### Task 12: Ops docs, CLAUDE.md updates, final verification

**Files:**
- Create: `docs/operations/email-copy-overrides.md`
- Modify: `apps/api/CLAUDE.md` ("Notifications & support are separate small pipelines" section — now inaccurate)
- Modify: root `.env.example` / `SETUP.md` ONLY IF they list notification env vars (check first; add `EMAIL_MESSAGES_PATH` alongside them if so).

- [ ] **Step 1: Write the ops doc**

```markdown
# Overriding email copy at deploy time

All email wording (subjects, bodies, button labels) lives in one properties
file. The bundled default ships in the API image at
`apps/api/src/notifications/email/messages.default.properties` (copied to
`dist/` in the build). Ops can override any line without a code change:

1. Copy the bundled file into a ConfigMap:
   `kubectl create configmap signals-email-messages --from-file=messages.properties=messages.default.properties`
2. Edit the wording you want to change. Keys you delete simply fall back to
   the bundled default — you can keep an override file containing ONLY the
   keys you changed.
3. Mount it and point the API at it:

   ```yaml
   volumeMounts:
     - name: email-messages
       mountPath: /etc/signals/email
   volumes:
     - name: email-messages
       configMap:
         name: signals-email-messages
   env:
     - name: EMAIL_MESSAGES_PATH
       value: /etc/signals/email/messages.properties
   ```

4. Restart the pods — the file is read once at boot.

Rules (also documented in comments inside the file):

- Values are single-line HTML fragments; `<p> <b> <a> <ol> <li>` are fine.
  The outer layout (header, CTA button, colours) is fixed in code.
- Placeholders are `{{likeThis}}`, optional, and per-template (see the
  comment above each section). Anything unrecognised renders as literal text.
- Placeholder VALUES are HTML-escaped automatically — a user's name can never
  inject markup.
- A missing/unparseable file or a typo'd key can never break email: every bad
  or absent key falls back to the bundled default, with a warning in the API
  logs (`email messages override: …`).
```

- [ ] **Step 2: Update `apps/api/CLAUDE.md`**

Rewrite the "Notifications & support are separate small pipelines" section to describe the new shape: `notifications/email/` (messages file → loader → registry → `dispatchEmail`) is the single send path; `build_notifications.ts` → `dispatcher.ts` still plans action emails but sends through it; support/guardian/auth emails are thin callers; copy lives in `messages.default.properties`, overridable via `EMAIL_MESSAGES_PATH` (link the ops doc).

- [ ] **Step 3: Final verification (whole epic)**

```bash
pnpm --filter api test
pnpm --filter auth exec vitest run
pnpm typecheck
pnpm --filter api build && ls apps/api/dist/messages.default.properties
git grep -n "wants to connect with you\|Congratulations\|Use this OTP\|has been raised by" -- 'apps/api/src/**/*.ts' 'packages/auth/src/**/*.ts'
```

Expected: all green; the final grep returns NO hits in `.ts` files (all copy is in the properties file — hits in `.properties`/tests/docs are fine).

- [ ] **Step 4: Commit**

```bash
git add -A docs apps/api/CLAUDE.md
git commit -m "docs: email copy override runbook + updated api notifications guide (#529)"
```

---

## Post-plan checklist (for the session driving this plan)

- Push the branch and open a **draft** PR into `feature` (`gh pr create --draft`), description = what changed (never "review fixes"), include an "In Plain Terms" section per root CLAUDE.md, and note the two deliberate behaviour decisions: support email stays critical (spec deviation from #529's wording), `welcome`/action emails best-effort; `DEFAULT_FROM_EMAIL` fallback preserves auth sends when `NOTIFICATION_FROM_EMAIL` is unset.
- Manual QA once deployed locally (`/run-signals-dpg` skill): trigger a login OTP email, a support submission, and a connect action; verify copy renders, then repeat with an `EMAIL_MESSAGES_PATH` override file containing one changed key + one typo'd key and confirm the changed key applies and the typo warns + falls back.
