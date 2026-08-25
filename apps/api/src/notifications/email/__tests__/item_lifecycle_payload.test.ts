import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config', () => ({ apiConfig: { served_domains: [] }, notification: {} }));

import { createEmailSender } from '../dispatch_email';
import { loadEmailMessagesIndex } from '../messages';

/**
 * Verification harness for the item-lifecycle emails (#531/#534): loads the
 * REAL shipped copy (messages.default.properties), renders each case through
 * the actual sender, and LOGS the exact payload that would be POSTed to the
 * notification-service — i.e. what goes on the wire "before sending". No live
 * NS / SMTP: `notify` is captured. Run with:
 *   pnpm --filter api exec vitest run .../item_lifecycle_payload.test.ts
 */

const DEFAULTS = readFileSync(join(__dirname, '..', 'messages.default.properties'), 'utf8');

function makeSender(teamName: string) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const index = loadEmailMessagesIndex({
    defaultsText: DEFAULTS,
    instanceOverrideText: '',
    layers: [],
    warn: () => {},
  });
  const sender = createEmailSender({
    notify,
    getMessages: () => Promise.resolve(index),
    fromEmail: 'noreply@bluedots.example',
    defaultReplyTo: 'reply@bluedots.example',
    defaultNetwork: 'blue_dot',
    teamName,
    log: () => {},
  });
  return { sender, notify };
}

const CASES: Array<{ caseId: string; vars: Record<string, string> }> = [
  { caseId: 'profile.create', vars: { name: 'Asha' } },
  { caseId: 'offer.create', vars: { name: 'Acme Services' } },
  { caseId: 'profile.create_incomplete', vars: { name: 'Asha' } },
  { caseId: 'offer.create_incomplete', vars: { name: 'Acme Services' } },
  { caseId: 'profile.update', vars: { name: 'Asha' } },
  { caseId: 'offer.update', vars: { name: 'Acme Services' } },
  { caseId: 'account.aggregator_init', vars: { name: 'Asha', aggregatorOrg: 'SkillBridge Network' } },
  { caseId: 'profile.pause', vars: { name: 'Asha' } },
  { caseId: 'offer.pause', vars: { name: 'Acme Services' } },
  { caseId: 'profile.retire', vars: { name: 'Asha' } },
  { caseId: 'offer.retire', vars: { name: 'Acme Services' } },
];

describe('item-lifecycle email payload (pre-notification-service)', () => {
  it('renders each case and logs the outbound NS payload', async () => {
    const { sender, notify } = makeSender('EkStep');

    for (const { caseId, vars } of CASES) {
      await sender.dispatchEmail({
        caseId,
        to: 'owner@example.com',
        fromName: 'Blue Dot',
        network: 'blue_dot',
        ctaUrl: 'https://app.bluedots.example',
        variables: vars,
      });
    }

    // One capture per case, in order.
    expect(notify).toHaveBeenCalledTimes(CASES.length);

    // eslint-disable-next-line no-console
    console.log('\n===== OUTBOUND notification-service payloads (item lifecycle) =====');
    notify.mock.calls.forEach(([req], i) => {
      const v = (req as { variables: Record<string, string> }).variables;
      // eslint-disable-next-line no-console
      console.log(
        `\n[${CASES[i]!.caseId}]  channel=${(req as { channel: string }).channel}  template_id=${(req as { template_id: string }).template_id}  to=${(req as { to: string }).to}` +
          `\n  subject: ${v.subject}` +
          `\n  html:    ${v.html.replace(/\s+/g, ' ').trim()}`,
      );
      // Every payload is a well-formed email to the NS email provider.
      expect((req as { channel: string }).channel).toBe('email');
      expect((req as { template_id: string }).template_id).toBe('basic_email');
      expect(v.subject.length).toBeGreaterThan(0);
      expect(v.html).toContain('EkStep'); // per-INSTANCE_NAME sign-off in the shell
      // CTA is wired on every case (guards a case→shell mis-wire).
      expect(v.html).toContain('https://app.bluedots.example');
    });

    // Spot-check substitution + copy on a couple of cases.
    const byCase = (id: string) =>
      notify.mock.calls[CASES.findIndex((c) => c.caseId === id)]![0] as {
        variables: Record<string, string>;
      };
    expect(byCase('profile.create').variables.subject).toBe('Your profile is ready');
    expect(byCase('profile.create').variables.html).toContain('Asha');
    expect(byCase('account.aggregator_init').variables.html).toContain('SkillBridge Network');
    expect(byCase('account.aggregator_init').variables.subject).toBe('Activate your account');
    // Draft-create copy must NOT claim "live"; it nudges completion (#1 review).
    expect(byCase('profile.create_incomplete').variables.subject).toBe('Complete your profile');
    expect(byCase('profile.create_incomplete').variables.html.toLowerCase()).not.toContain('is live');
    expect(byCase('offer.create_incomplete').variables.subject).toBe('Complete your offer');
  });

  it('HTML-escapes owner-supplied names (no injection via user.name)', async () => {
    const { sender, notify } = makeSender('EkStep');
    await sender.dispatchEmail({
      caseId: 'profile.create',
      to: 'owner@example.com',
      fromName: 'Blue Dot',
      network: 'blue_dot',
      ctaUrl: 'https://app.bluedots.example',
      variables: { name: '<script>alert(1)</script>' },
    });
    const html = (notify.mock.calls[0]![0] as { variables: { html: string } }).variables.html;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
