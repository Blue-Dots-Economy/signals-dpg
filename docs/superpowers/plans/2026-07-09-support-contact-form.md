# Support / contact form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Contact support" item to the authenticated user menu that opens a network-themed form and emails the submission (plus the submitter's details) to the configured `SUPPORT_EMAIL` via the existing notification service.

**Architecture:** A pure email-builder helper + a session-authenticated `POST /api/v1/support` route that reuses `getNotificationClient()` and the `basic_email` template. The UI adds a dialog (built on existing primitives) opened from the user menu. Email-only — audit/metrics are out of scope (deferred to telemetry).

**Tech Stack:** TypeScript (ESM), Zod, Fastify + `fastify-type-provider-zod`, Drizzle, `@dpg/notification`, React 19 + Vite, `axios`, Vitest, `@testing-library/react`.

## Global Constraints

- ESM only, strict TS, no `any`; `import type` for type-only imports.
- Routes return `reply.code(N).send({ error, message })` with machine-readable `error`; log failures with `request.log.error({ err, ... }, 'message')`.
- New env vars require TWO changes: the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv`.
- `SUPPORT_EMAIL` is `z.string().optional()` (feature-gated on presence, not required-at-boot).
- Error codes: `SUPPORT_NOT_CONFIGURED` (503), `SUPPORT_SEND_FAILED` (502), body validation (400).
- Email uses the existing `NotificationClient.notify({ channel:'email', template_id:'basic_email', to, priority:'other', variables:{ fromName, fromEmail, replyTo, subject, html } })`.
- All user-supplied text (subject, message, name) is HTML-escaped in the email body.
- The endpoint **awaits** the send and reports success/failure (not fire-and-forget).
- i18n keys are flat dotted keys (`"support.dialog_title"`) added to `en.json`, `hi.json`, `kn.json`.
- Files snake_case; Zod schemas PascalCase. Node >=24, pnpm@11.1.2. Package filters: `@dpg/config` → `config`, `@dpg/auth` → `auth`, api → `api`, ui → `ui`.

---

## File Structure

- `apps/api/src/support/build_support_email.ts` — **create.** Pure `buildSupportEmail(input) → { subject, html }` with HTML-escaping.
- `packages/config/src/secrets.ts` — **modify.** Add `SUPPORT_EMAIL` to `NotificationSecretsSchema`.
- `apps/api/src/config.ts` — **modify.** Export `supportConfig` `{ recipient, fromEmail }`.
- `turbo.json` — **modify.** Add `SUPPORT_EMAIL` to `globalPassThroughEnv`.
- `apps/api/src/routes/v1/support/submit_support.ts` — **create.** `POST /support` route.
- `apps/api/src/routes/v1/v1_routes.ts` — **modify.** Register the route at `/support`.
- `apps/ui/src/lib/support-api.ts` — **create.** `submitSupport()`.
- `apps/ui/src/components/support/support-dialog.tsx` — **create.** The themed form dialog.
- `apps/ui/src/components/auth/user-menu.tsx` — **modify.** Add the Contact-support item + dialog.
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — **modify.** Add menu + support keys.
- `.env.example`, `SETUP.md` — **modify.** Document `SUPPORT_EMAIL`.

---

### Task 1: `buildSupportEmail` pure helper

**Files:**
- Create: `apps/api/src/support/build_support_email.ts`
- Test: `apps/api/src/support/__tests__/build_support_email.test.ts`

**Interfaces:**
- Produces:
  - `interface SupportSubmitter { name: string; email: string | null; phone: string | null; userId: string; network: string }`
  - `interface BuildSupportEmailInput { subject?: string; message: string; submitter: SupportSubmitter; submittedAt: string }`
  - `interface SupportEmail { subject: string; html: string }`
  - `buildSupportEmail(input: BuildSupportEmailInput): SupportEmail`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/support/__tests__/build_support_email.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSupportEmail } from '../build_support_email';

const submitter = {
  name: 'Asha K',
  email: 'asha@example.com',
  phone: '+919000000000',
  userId: 'user-123',
  network: 'blue_dot',
};

describe('buildSupportEmail', () => {
  it('uses the provided subject in the subject line', () => {
    const { subject } = buildSupportEmail({
      subject: 'Cannot log in',
      message: 'It fails',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] Cannot log in — Asha K');
  });

  it('falls back to a default subject when none given', () => {
    const { subject } = buildSupportEmail({
      message: 'hi',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] New support request — Asha K');
  });

  it('includes the message and every submitter detail in the html', () => {
    const { html } = buildSupportEmail({
      message: 'My profile broke',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(html).toContain('My profile broke');
    expect(html).toContain('Asha K');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('+919000000000');
    expect(html).toContain('user-123');
    expect(html).toContain('blue_dot');
    expect(html).toContain('2026-07-09T10:00:00.000Z');
  });

  it('HTML-escapes user-supplied message and name', () => {
    const { html } = buildSupportEmail({
      message: '<script>alert(1)</script>',
      submitter: { ...submitter, name: 'A<b>C' },
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('A&lt;b&gt;C');
  });

  it('strips newlines from the subject and renders — for missing email/phone', () => {
    const { subject, html } = buildSupportEmail({
      subject: 'line1\nline2',
      message: 'x',
      submitter: { ...submitter, email: null, phone: null },
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] line1 line2 — Asha K');
    expect(html).toContain('—');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/support/__tests__/build_support_email.test.ts`
Expected: FAIL — cannot find module `../build_support_email`.

- [ ] **Step 3: Create the helper**

Create `apps/api/src/support/build_support_email.ts`:

```ts
export interface SupportSubmitter {
  name: string;
  email: string | null;
  phone: string | null;
  userId: string;
  network: string;
}

export interface BuildSupportEmailInput {
  subject?: string;
  message: string;
  submitter: SupportSubmitter;
  /** ISO-8601 timestamp, stamped by the caller. */
  submittedAt: string;
}

export interface SupportEmail {
  subject: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Collapse any CR/LF/tabs to single spaces so they can't break an email header. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the support notification email. Pure: the caller supplies the
 * timestamp and resolved submitter details. All user-controlled strings are
 * HTML-escaped in the body; the subject is flattened to a single line.
 */
export function buildSupportEmail(input: BuildSupportEmailInput): SupportEmail {
  const { message, submitter, submittedAt } = input;
  const trimmedSubject = input.subject?.trim();
  const subjectText = trimmedSubject ? oneLine(trimmedSubject) : 'New support request';
  const subject = `[Support] ${subjectText} — ${oneLine(submitter.name)}`;

  const rows: Array<[string, string]> = [
    ['Name', submitter.name],
    ['Email', submitter.email ?? '—'],
    ['Phone', submitter.phone ?? '—'],
    ['User ID', submitter.userId],
    ['Network', submitter.network],
    ['Submitted at', submittedAt],
  ];
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const html = `<div>
  <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
  <hr />
  <table style="border-collapse:collapse;font-size:13px">${detailRows}</table>
</div>`;

  return { subject, html };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/support/__tests__/build_support_email.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/support/build_support_email.ts apps/api/src/support/__tests__/build_support_email.test.ts
git commit -m "feat(api): add support email builder (#120)"
```

---

### Task 2: Config — `SUPPORT_EMAIL` + `supportConfig` + turbo passthrough

**Files:**
- Modify: `packages/config/src/secrets.ts` (`NotificationSecretsSchema`)
- Modify: `apps/api/src/config.ts`
- Modify: `turbo.json`

**Interfaces:**
- Produces: `NotificationSecretsSchema` gains `SUPPORT_EMAIL: string | undefined`; `apps/api/src/config.ts` exports `supportConfig: { recipient: string | undefined; fromEmail: string | undefined }`.

- [ ] **Step 1: Add `SUPPORT_EMAIL` to the notification secrets schema**

In `packages/config/src/secrets.ts`, inside `NotificationSecretsSchema` (after `FRONTEND_BASE_URL`), add:

```ts
  // Recipient for support/contact-form submissions (#120). Optional so the API
  // still boots without it; the feature is gated on its presence (the endpoint
  // returns 503 and the UI hides/toasts when unset).
  SUPPORT_EMAIL: z.string().optional(),
```

- [ ] **Step 2: Export `supportConfig` from the API config**

In `apps/api/src/config.ts`, after the `authConfig` export, add:

```ts
export const supportConfig = {
  recipient: notification.SUPPORT_EMAIL,
  fromEmail: notification.NOTIFICATION_FROM_EMAIL,
};
```

(`notification` is already destructured from `loadEnv()` at the top of the file. Do not import `getNotificationClient` here — it imports from `@/config` and would create a cycle; the route checks the client itself.)

- [ ] **Step 3: Add `SUPPORT_EMAIL` to turbo passthrough**

In `turbo.json`, add `"SUPPORT_EMAIL"` to the `globalPassThroughEnv` array.

- [ ] **Step 4: Verify typecheck + config tests**

Run: `pnpm --filter config exec vitest run && pnpm typecheck`
Expected: PASS, no type errors. (This task is wiring; `supportConfig` is exercised by Task 3's integration test.)

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/secrets.ts apps/api/src/config.ts turbo.json
git commit -m "feat(config): add SUPPORT_EMAIL + supportConfig (#120)"
```

---

### Task 3: `POST /api/v1/support` route

**Files:**
- Create: `apps/api/src/routes/v1/support/submit_support.ts`
- Modify: `apps/api/src/routes/v1/v1_routes.ts`
- Test: `apps/api/src/routes/v1/support/__tests__/submit_support.test.ts`

**Interfaces:**
- Consumes: `buildSupportEmail` (Task 1); `supportConfig` (Task 2); `getNotificationClient` (`apps/api/src/utils/notificationClient.ts`); `db` + `user` schema; `auth_middleware_if_enabled`; `apiConfig`, `instance` from `@/config`.
- Produces: `POST /api/v1/support` accepting `{ subject?: string; message: string }`; 201 `{ ok: true }` / 503 `SUPPORT_NOT_CONFIGURED` / 502 `SUPPORT_SEND_FAILED` / 400 validation / 401 unauth.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/support/__tests__/submit_support.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const notifyMock = vi.fn();

function mockDeps(cfg: { recipient?: string; fromEmail?: string; client?: boolean }) {
  vi.doMock('@api/plugins/auth/auth_middleware', () => ({
    auth_middleware_if_enabled: async (req: { user?: { id: string } }) => {
      req.user = { id: 'u1' };
    },
  }));
  vi.doMock('@/utils/notificationClient', () => ({
    getNotificationClient: () => (cfg.client === false ? undefined : { notify: notifyMock }),
  }));
  vi.doMock('@/config', () => ({
    supportConfig: { recipient: cfg.recipient, fromEmail: cfg.fromEmail },
    apiConfig: { served_domains: [{ network: 'blue_dot', domain: 'seeker', key: 'blue_dot/seeker' }] },
    instance: { INSTANCE_NAME: 'Blue Dot' },
  }));
  vi.doMock('@api/db/postgres/drizzle_config', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ name: 'Asha', email: 'asha@example.com', phone: '+919000000000' }]),
          }),
        }),
      }),
    },
  }));
}

async function buildApp() {
  const { submit_support } = await import('../submit_support');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(submit_support, { prefix: '/api/v1/support' });
  await app.ready();
  return app;
}

describe('POST /api/v1/support', () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
  });

  it('sends the support email and returns 201', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { subject: 'Help', message: 'It broke' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0][0];
    expect(arg.to).toBe('support@org.com');
    expect(arg.variables.replyTo).toBe('asha@example.com');
    expect(arg.variables.subject).toContain('Help');
    expect(arg.variables.html).toContain('It broke');
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when SUPPORT_EMAIL is unset', async () => {
    mockDeps({ recipient: undefined, fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(notifyMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when message is empty', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/support/__tests__/submit_support.test.ts`
Expected: FAIL — cannot find module `../submit_support`.

- [ ] **Step 3: Create the route**

Create `apps/api/src/routes/v1/support/submit_support.ts`:

```ts
import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig, instance, supportConfig } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';
import { buildSupportEmail } from '@/support/build_support_email';

const SubmitSupportBody = z.object({
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(5000),
});

type Body = z.infer<typeof SubmitSupportBody>;

export const submit_support: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['support'],
      body: SubmitSupportBody,
    },
    handler: submit_support_handler,
  });
};

export const submit_support_handler = async (
  request: FastifyRequest<{ Body: Body }>,
  reply: FastifyReply
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  }

  const nc = getNotificationClient();
  if (!supportConfig.recipient || !supportConfig.fromEmail || !nc) {
    return reply.code(503).send({
      error: 'SUPPORT_NOT_CONFIGURED',
      message: 'Support is not configured on this instance.',
    });
  }

  const { subject, message } = request.body;

  const [row] = await db
    .select({ name: user.name, email: user.email, phone: user.phoneNumber })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'User not found' });
  }

  const network =
    [...new Set(apiConfig.served_domains.map((binding) => binding.network))].join(', ') || '—';

  const { subject: emailSubject, html } = buildSupportEmail({
    subject,
    message,
    submitter: {
      name: row.name,
      email: row.email,
      phone: row.phone,
      userId,
      network,
    },
    submittedAt: new Date().toISOString(),
  });

  try {
    await nc.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: supportConfig.recipient,
      priority: 'other',
      variables: {
        fromName: `${instance.INSTANCE_NAME ?? 'DPG'} Support`,
        fromEmail: supportConfig.fromEmail,
        replyTo: row.email ?? supportConfig.fromEmail,
        subject: emailSubject,
        html,
      },
    });
  } catch (err) {
    request.log.error({ err }, 'support email send failed');
    return reply.code(502).send({
      error: 'SUPPORT_SEND_FAILED',
      message: 'Failed to send your message. Please try again later.',
    });
  }

  return reply.code(201).send({ ok: true });
};
```

- [ ] **Step 4: Register the route**

In `apps/api/src/routes/v1/v1_routes.ts`, add the import with the others:

```ts
import { submit_support } from '@/routes/v1/support/submit_support';
```
and register it inside the plugin body with the other `fastify.register(...)` calls:

```ts
  fastify.register(submit_support, { prefix: '/support' });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/support/__tests__/submit_support.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/v1/support/submit_support.ts apps/api/src/routes/v1/support/__tests__/submit_support.test.ts apps/api/src/routes/v1/v1_routes.ts
git commit -m "feat(api): add POST /api/v1/support (email a submission to SUPPORT_EMAIL) (#120)"
```

---

### Task 4: UI — support API client, dialog, and user-menu item

**Files:**
- Create: `apps/ui/src/lib/support-api.ts`
- Create: `apps/ui/src/components/support/support-dialog.tsx`
- Modify: `apps/ui/src/components/auth/user-menu.tsx`
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`
- Test: `apps/ui/src/lib/__tests__/support-api.test.ts`
- Test: `apps/ui/src/components/support/__tests__/support-dialog.test.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/support` (Task 3).
- Produces: `submitSupport(input: { subject?: string; message: string }): Promise<void>`; `SupportDialog` component with props `{ open: boolean; onOpenChange: (open: boolean) => void }`.

- [ ] **Step 1: Write the failing support-api test**

Create `apps/ui/src/lib/__tests__/support-api.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('submitSupport', () => {
  it('POSTs message (and subject when present) to /api/v1/support', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { ok: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitSupport } = await import('../support-api');
    await submitSupport({ subject: 'Help', message: 'It broke' });
    expect(post).toHaveBeenCalledWith('/api/v1/support', { subject: 'Help', message: 'It broke' });
  });

  it('omits subject when not provided', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { ok: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitSupport } = await import('../support-api');
    await submitSupport({ message: 'hi' });
    expect(post).toHaveBeenCalledWith('/api/v1/support', { message: 'hi' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/support-api.test.ts`
Expected: FAIL — cannot find module `../support-api`.

- [ ] **Step 3: Create `support-api.ts`**

Create `apps/ui/src/lib/support-api.ts`:

```ts
import { createApiClient } from './api-client';

const apiClient = createApiClient();

export interface SupportSubmission {
  subject?: string;
  message: string;
}

export async function submitSupport(input: SupportSubmission): Promise<void> {
  await apiClient.post('/api/v1/support', {
    ...(input.subject ? { subject: input.subject } : {}),
    message: input.message,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/support-api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add i18n keys (en/hi/kn)**

In `apps/ui/src/i18n/locales/en.json`, add these keys (anchor after the existing `"menu.sign_out"` key; keep valid JSON with commas):

```json
  "menu.contact_support": "Contact support",
  "support.dialog_title": "Contact support",
  "support.dialog_desc": "Tell us what's going on and we'll get back to you.",
  "support.label_subject": "Subject (optional)",
  "support.placeholder_subject": "Brief summary",
  "support.label_message": "Message",
  "support.placeholder_message": "Describe your issue or request",
  "support.submit": "Send",
  "support.cancel": "Cancel",
  "support.validation_message_required": "Please enter a message",
  "support.toast_sent": "Message sent",
  "support.toast_sent_desc": "Our team will get back to you.",
  "support.toast_unavailable": "Support is unavailable",
  "support.toast_unavailable_desc": "Support isn't available right now. Please try again later.",
  "support.toast_error": "Couldn't send your message",
  "support.toast_error_desc": "Please try again in a moment.",
```

In `apps/ui/src/i18n/locales/hi.json`, add the same keys:

```json
  "menu.contact_support": "सहायता से संपर्क करें",
  "support.dialog_title": "सहायता से संपर्क करें",
  "support.dialog_desc": "हमें बताएं कि क्या समस्या है और हम आपसे संपर्क करेंगे।",
  "support.label_subject": "विषय (वैकल्पिक)",
  "support.placeholder_subject": "संक्षिप्त सारांश",
  "support.label_message": "संदेश",
  "support.placeholder_message": "अपनी समस्या या अनुरोध का वर्णन करें",
  "support.submit": "भेजें",
  "support.cancel": "रद्द करें",
  "support.validation_message_required": "कृपया एक संदेश दर्ज करें",
  "support.toast_sent": "संदेश भेजा गया",
  "support.toast_sent_desc": "हमारी टीम आपसे संपर्क करेगी।",
  "support.toast_unavailable": "सहायता उपलब्ध नहीं है",
  "support.toast_unavailable_desc": "सहायता अभी उपलब्ध नहीं है। कृपया बाद में पुनः प्रयास करें।",
  "support.toast_error": "आपका संदेश नहीं भेजा जा सका",
  "support.toast_error_desc": "कृपया कुछ देर बाद पुनः प्रयास करें।",
```

In `apps/ui/src/i18n/locales/kn.json`, add the same keys:

```json
  "menu.contact_support": "ಬೆಂಬಲವನ್ನು ಸಂಪರ್ಕಿಸಿ",
  "support.dialog_title": "ಬೆಂಬಲವನ್ನು ಸಂಪರ್ಕಿಸಿ",
  "support.dialog_desc": "ಏನಾಗುತ್ತಿದೆ ಎಂದು ನಮಗೆ ತಿಳಿಸಿ, ನಾವು ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತೇವೆ.",
  "support.label_subject": "ವಿಷಯ (ಐಚ್ಛಿಕ)",
  "support.placeholder_subject": "ಸಂಕ್ಷಿಪ್ತ ಸಾರಾಂಶ",
  "support.label_message": "ಸಂದೇಶ",
  "support.placeholder_message": "ನಿಮ್ಮ ಸಮಸ್ಯೆ ಅಥವಾ ವಿನಂತಿಯನ್ನು ವಿವರಿಸಿ",
  "support.submit": "ಕಳುಹಿಸಿ",
  "support.cancel": "ರದ್ದುಮಾಡಿ",
  "support.validation_message_required": "ದಯವಿಟ್ಟು ಒಂದು ಸಂದೇಶವನ್ನು ನಮೂದಿಸಿ",
  "support.toast_sent": "ಸಂದೇಶ ಕಳುಹಿಸಲಾಗಿದೆ",
  "support.toast_sent_desc": "ನಮ್ಮ ತಂಡ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತದೆ.",
  "support.toast_unavailable": "ಬೆಂಬಲ ಲಭ್ಯವಿಲ್ಲ",
  "support.toast_unavailable_desc": "ಬೆಂಬಲ ಸದ್ಯ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಂತರ ಪ್ರಯತ್ನಿಸಿ.",
  "support.toast_error": "ನಿಮ್ಮ ಸಂದೇಶವನ್ನು ಕಳುಹಿಸಲಾಗಲಿಲ್ಲ",
  "support.toast_error_desc": "ದಯವಿಟ್ಟು ಕ್ಷಣದಲ್ಲಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
```

- [ ] **Step 6: Write the failing support-dialog test**

Create `apps/ui/src/components/support/__tests__/support-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const submitSupport = vi.fn();
vi.mock('@/lib/support-api', () => ({ submitSupport: (...a: unknown[]) => submitSupport(...a) }));

async function renderDialog() {
  const { SupportDialog } = await import('../support-dialog');
  render(<SupportDialog open={true} onOpenChange={() => {}} />);
}

describe('SupportDialog', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not submit when the message is empty', async () => {
    await renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(submitSupport).not.toHaveBeenCalled();
  });

  it('submits the message and calls submitSupport', async () => {
    submitSupport.mockResolvedValue(undefined);
    await renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'It broke');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitSupport).toHaveBeenCalledWith({ subject: undefined, message: 'It broke' }));
  });

  it('shows the unavailable message on a 503 response', async () => {
    submitSupport.mockRejectedValue({ isAxiosError: true, response: { status: 503 } });
    await renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/isn't available|unavailable/i)).toBeTruthy());
  });
});
```

Note: the test asserts `submitSupport` is called with `subject: undefined` when the subject field is left blank. Implement the submit handler to pass `subject: subject.trim() || undefined` so this holds.

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/support/__tests__/support-dialog.test.tsx`
Expected: FAIL — cannot find module `../support-dialog`.

- [ ] **Step 8: Create `support-dialog.tsx`**

Create `apps/ui/src/components/support/support-dialog.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import axios from 'axios';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { submitSupport } from '@/lib/support-api';

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SupportDialog({ open, onOpenChange }: SupportDialogProps) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setSubject('');
    setMessage('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      toast.error(t('support.validation_message_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      await submitSupport({ subject: subject.trim() || undefined, message: message.trim() });
      toast.success(t('support.toast_sent'), { description: t('support.toast_sent_desc') });
      reset();
      onOpenChange(false);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        toast.error(t('support.toast_unavailable'), { description: t('support.toast_unavailable_desc') });
      } else {
        toast.error(t('support.toast_error'), { description: t('support.toast_error_desc') });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('support.dialog_title')}</DialogTitle>
          <DialogDescription>{t('support.dialog_desc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="support-subject">{t('support.label_subject')}</Label>
            <Input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('support.placeholder_subject')}
              maxLength={200}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-message">{t('support.label_message')}</Label>
            <Textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('support.placeholder_message')}
              maxLength={5000}
              rows={5}
              disabled={isSubmitting}
              required
            />
          </div>
          <DialogFooter>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('support.submit')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 9: Run the dialog test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/support/__tests__/support-dialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 10: Add the Contact-support item to the user menu**

In `apps/ui/src/components/auth/user-menu.tsx`:

Add imports (extend the existing `lucide-react` import and add `useState` + the dialog):
```ts
import { useState } from 'react';
import { LogOut, LifeBuoy } from 'lucide-react';
import { SupportDialog } from '@/components/support/support-dialog';
```

Add state inside the component (near the top of `UserMenu`, after the hooks):
```ts
  const [supportOpen, setSupportOpen] = useState(false);
```

Insert a Contact-support section between the user-info `<div>` and the sign-out `<div className="border-t p-1">` — i.e. immediately before the sign-out block:
```tsx
        <div className="border-t p-1">
          <button
            type="button"
            onClick={() => setSupportOpen(true)}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent"
          >
            <LifeBuoy className="h-4 w-4" />
            {t('menu.contact_support')}
          </button>
        </div>
```

Render the dialog once — wrap the returned `<Popover>...</Popover>` in a fragment and add the dialog as a sibling:
```tsx
  return (
    <>
      <Popover>
        {/* ...existing Popover content unchanged... */}
      </Popover>
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </>
  );
```

- [ ] **Step 11: Typecheck + run the UI suite**

Run: `pnpm --filter ui exec tsc --noEmit && pnpm --filter ui exec vitest run`
Expected: no type errors; all tests pass (existing + new support-api + support-dialog).

- [ ] **Step 12: Commit**

```bash
git add apps/ui/src/lib/support-api.ts apps/ui/src/components/support/support-dialog.tsx apps/ui/src/components/auth/user-menu.tsx apps/ui/src/lib/__tests__/support-api.test.ts apps/ui/src/components/support/__tests__/support-dialog.test.tsx apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): Contact support menu item + themed dialog (#120)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `SETUP.md`

- [ ] **Step 1: Document `SUPPORT_EMAIL` in `.env.example`**

Add near the other notification vars (`NOTIFICATION_FROM_EMAIL`):

```bash
# Recipient for support/contact-form submissions (#120). When unset, the
# Contact-support form returns 503 and the UI shows an "unavailable" message.
# Requires NOTIFICATION_FROM_EMAIL and the notification-service credentials.
SUPPORT_EMAIL=support@example.org
```

NOTE: `.env.example` may be permission-blocked in some environments. If editing it is denied, complete the `SETUP.md` change and report the `.env.example` change as a manual follow-up (do not spend many turns fighting a permission denial).

- [ ] **Step 2: Note it in `SETUP.md`**

Add a short line under the notification/config area:

```markdown
- `SUPPORT_EMAIL` — recipient for the in-app "Contact support" form. Emails are sent via the
  notification service from `NOTIFICATION_FROM_EMAIL`, with Reply-To set to the submitting user.
  When unset, the form is disabled (API returns 503).
```

- [ ] **Step 3: Commit**

```bash
git add .env.example SETUP.md
git commit -m "docs: document SUPPORT_EMAIL (#120)"
```

---

## Self-Review

**1. Spec coverage:**
- `SUPPORT_EMAIL` env (schema-optional, feature-gated) → Task 2. ✅
- Pure email builder with HTML-escaping + full user details → Task 1. ✅
- `POST /api/v1/support` authenticated, awaits send, 201/503/502/400, Reply-To = submitter, `basic_email` → Task 3. ✅
- Network resolved from served_domains; user details from the `user` row → Task 3. ✅
- UI: submitSupport, themed dialog (bg-brand-cta), always-shown Contact-support menu item, i18n en/hi/kn, success/unavailable/error toasts → Task 4. ✅
- Docs → Task 5. ✅
- Out of scope (audit/metrics, attachments) → not implemented, per spec. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has full code. The `.env.example` step carries a permission-block fallback (not a placeholder). i18n values are provided verbatim for all three locales.

**3. Type consistency:** `buildSupportEmail` / `SupportSubmitter` / `BuildSupportEmailInput` / `SupportEmail` names match between Task 1 and Task 3. `supportConfig.{recipient,fromEmail}` match between Task 2 and Task 3. `submitSupport({ subject?, message })` and `SupportDialog {open,onOpenChange}` match between Task 4's api, dialog, and user-menu. Notify variables `{fromName, fromEmail, replyTo, subject, html}` match the existing `basic_email` shape.
