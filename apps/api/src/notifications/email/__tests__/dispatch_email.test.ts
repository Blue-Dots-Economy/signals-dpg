import { describe, expect, it, vi } from 'vitest';
import type { LoadedEmailMessagesFile } from '@dpg/config';

// getInstanceDefaultNetwork() (only) reads apiConfig.served_domains at call
// time; mock just that field of `@/config` (the notification-copy tests below
// never touch config, so this is inert for them).
const mockApiConfig = vi.hoisted(() => ({
  served_domains: [] as { network: string; domain: string; key: string }[],
}));
vi.mock('@/config', () => ({
  apiConfig: mockApiConfig,
  notification: {},
}));

import { createEmailSender, getInstanceDefaultNetwork } from '../dispatch_email';
import { loadEmailMessagesIndex } from '../messages';
import { requiredMessageKeys } from '../email_cases';

function messagesWith(overrides: Record<string, string>, layers: LoadedEmailMessagesFile[] = []) {
  const defaults = requiredMessageKeys()
    .map((k) => `${k}=[${k}]`)
    .join('\n');
  const instanceOverrideText = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const index = loadEmailMessagesIndex({
    defaultsText: defaults,
    instanceOverrideText,
    layers,
    warn: () => {},
  });
  return () => Promise.resolve(index);
}

function makeSender(
  overrides: Record<string, string> = {},
  opts: { layers?: LoadedEmailMessagesFile[]; defaultNetwork?: string | null } = {},
) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const sender = createEmailSender({
    notify,
    getMessages: messagesWith(overrides, opts.layers),
    fromEmail: 'noreply@x.example',
    defaultReplyTo: 'reply@x.example',
    defaultNetwork: opts.defaultNetwork ?? null,
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

  describe('network/brand context (#529 addendum)', () => {
    it('uses deps.defaultNetwork when args.network is absent', async () => {
      const layers: LoadedEmailMessagesFile[] = [
        { network: 'blue_dot', brand: null, text: 'welcome.subject=Blue Dot Welcome' },
      ];
      const { sender, notify } = makeSender(
        { 'welcome.body': '<p>hi</p>' },
        { layers, defaultNetwork: 'blue_dot' },
      );
      await sender.dispatchEmail({
        caseId: 'welcome',
        to: 'u@x.example',
        fromName: 'X',
        variables: {},
      });
      expect(notify.mock.calls[0][0].variables.subject).toBe('Blue Dot Welcome');
    });

    it('args.network wins over deps.defaultNetwork when both are present', async () => {
      const layers: LoadedEmailMessagesFile[] = [
        { network: 'blue_dot', brand: null, text: 'welcome.subject=Blue Dot Welcome' },
        { network: 'yellow_dot', brand: null, text: 'welcome.subject=Yellow Dot Welcome' },
      ];
      const { sender, notify } = makeSender(
        { 'welcome.body': '<p>hi</p>' },
        { layers, defaultNetwork: 'blue_dot' },
      );
      await sender.dispatchEmail({
        caseId: 'welcome',
        to: 'u@x.example',
        fromName: 'X',
        network: 'yellow_dot',
        variables: {},
      });
      expect(notify.mock.calls[0][0].variables.subject).toBe('Yellow Dot Welcome');
    });

    it('passes args.brand through to forContext, picking up the brand-layer copy', async () => {
      const layers: LoadedEmailMessagesFile[] = [
        { network: 'blue_dot', brand: null, text: 'welcome.subject=Network Welcome' },
        { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Welcome' },
      ];
      const { sender, notify } = makeSender({ 'welcome.body': '<p>hi</p>' }, { layers });
      await sender.dispatchEmail({
        caseId: 'welcome',
        to: 'u@x.example',
        fromName: 'X',
        network: 'blue_dot',
        brand: 'upsdm',
        variables: {},
      });
      expect(notify.mock.calls[0][0].variables.subject).toBe('Brand Welcome');
    });
  });
});

describe('getInstanceDefaultNetwork', () => {
  it('returns the single served network', () => {
    mockApiConfig.served_domains = [{ network: 'blue_dot', domain: 'blue.example', key: 'k' }];
    expect(getInstanceDefaultNetwork()).toBe('blue_dot');
  });

  it('dedupes multiple domain bindings on the same network', () => {
    mockApiConfig.served_domains = [
      { network: 'blue_dot', domain: 'blue.example', key: 'k1' },
      { network: 'blue_dot', domain: 'blue2.example', key: 'k2' },
    ];
    expect(getInstanceDefaultNetwork()).toBe('blue_dot');
  });

  it('returns null for a multi-network instance', () => {
    mockApiConfig.served_domains = [
      { network: 'blue_dot', domain: 'blue.example', key: 'k1' },
      { network: 'yellow_dot', domain: 'yellow.example', key: 'k2' },
    ];
    expect(getInstanceDefaultNetwork()).toBeNull();
  });

  it('returns null when no domains are served', () => {
    mockApiConfig.served_domains = [];
    expect(getInstanceDefaultNetwork()).toBeNull();
  });
});

