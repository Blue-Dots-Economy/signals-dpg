import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client } = vi.hoisted(() => ({ client: { current: undefined as unknown } }));

vi.mock('@/utils/notificationClient', () => ({ getNotificationClient: () => client.current }));
vi.mock('@/config', () => ({ instance: { INSTANCE_ENV: 'production' } }));
vi.mock('../../email/dispatch_email', () => ({ getInstanceDefaultNetwork: () => 'purple_dot' }));
vi.mock('../templates', () => ({ getSmsTemplates: async () => new Map() }));

import {
  createSmsSender,
  getDefaultSmsSender,
  resetDefaultSmsSenderForTests,
  smsLink,
  type SmsNotifyRequest,
} from '../dispatch_sms';
import { loadSmsTemplateIndex } from '../sms_templates';

function senderWith(props: string, opts: { previewLog?: (l: string) => void } = {}) {
  const index = loadSmsTemplateIndex([props]);
  const notify = vi.fn(async (_req: SmsNotifyRequest) => undefined);
  const log = vi.fn();
  const sender = createSmsSender({
    notify,
    getTemplates: () => index,
    defaultNetwork: 'blue_dot',
    previewLog: opts.previewLog,
    log,
  });
  return { sender, notify, log };
}

const CONFIGURED = [
  'profile.create.template_id=FLOW123',
  'profile.create.body=Ready {{name}}: {{link}}',
  'profile.create.vars=name,link',
].join('\n');

describe('dispatchSms', () => {
  it('sends provider-agnostic notify with the DLT template_id and variables', async () => {
    const { sender, notify } = senderWith(CONFIGURED);
    const res = await sender.dispatchSms({
      caseId: 'profile.create',
      to: '+919000000000',
      variables: { name: 'Asha', link: 'https://x' },
    });

    expect(res).toEqual({ ok: true });
    expect(notify).toHaveBeenCalledWith({
      channel: 'sms',
      template_id: 'FLOW123',
      to: '+919000000000',
      priority: 'other',
      variables: { name: 'Asha', link: 'https://x' },
    });
  });

  it('forwards only declared vars, dropping undeclared extras', async () => {
    const { sender, notify } = senderWith(CONFIGURED);
    await sender.dispatchSms({
      caseId: 'profile.create',
      to: '+91900',
      variables: { name: 'Asha', link: 'L', secret: 'drop-me' },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { name: 'Asha', link: 'L' } }),
    );
  });

  it('warns (and still sends) when a declared var is missing', async () => {
    const { sender, notify, log } = senderWith(CONFIGURED);
    const res = await sender.dispatchSms({
      caseId: 'profile.create',
      to: '+91900',
      variables: { name: 'Asha' }, // link missing
    });
    expect(res).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith(
      'sms missing declared variables',
      expect.objectContaining({ missing: ['link'] }),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variables: { name: 'Asha' } }));
  });

  it('forwards an explicit priority instead of the default', async () => {
    const { sender, notify } = senderWith(CONFIGURED);
    await sender.dispatchSms({ caseId: 'profile.create', to: '+91900', priority: 'realtime' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ priority: 'realtime' }));
  });

  it('skips (no-op) when the case has no approved template_id', async () => {
    const { sender, notify } = senderWith('profile.create.template_id=\nprofile.create.vars=name');
    const res = await sender.dispatchSms({ caseId: 'profile.create', to: '+91900' });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips when the case id is unknown', async () => {
    const { sender, notify } = senderWith(CONFIGURED);
    const res = await sender.dispatchSms({ caseId: 'nope.nope', to: '+91900' });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('renders the reference body to the preview log (dev only), never to notify', async () => {
    const previewLog = vi.fn();
    const { sender } = senderWith(CONFIGURED, { previewLog });
    await sender.dispatchSms({
      caseId: 'profile.create',
      to: '+919812345678',
      variables: { name: 'Asha', link: 'L' },
    });
    expect(previewLog).toHaveBeenCalledTimes(1);
    const line = previewLog.mock.calls[0][0];
    expect(line).toContain('Ready Asha: L');
    // Phone is masked — the full number never reaches a log-bound string.
    expect(line).toContain('****5678');
    expect(line).not.toContain('919812345678');
  });

  it('keeps a critical (OTP) send out of the preview log but still sends it', async () => {
    const previewLog = vi.fn();
    const { sender, notify } = senderWith(CONFIGURED, { previewLog });
    const res = await sender.dispatchSms({
      caseId: 'profile.create',
      to: '+919812345678',
      critical: true,
      variables: { name: 'Asha', link: 'L' },
    });
    expect(res).toEqual({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(previewLog).not.toHaveBeenCalled();
  });

  it('never throws — a notify failure is swallowed and reported as not-ok', async () => {
    const index = loadSmsTemplateIndex([CONFIGURED]);
    const notify = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const sender = createSmsSender({ notify, getTemplates: () => index, defaultNetwork: null, log });
    const res = await sender.dispatchSms({ caseId: 'profile.create', to: '+91900' });
    expect(res).toEqual({ ok: false });
    // Message only — the raw error object (may carry phone/vars) is never logged.
    expect(log).toHaveBeenCalledWith('sms dispatch failed', {
      caseId: 'profile.create',
      error: 'boom',
    });
  });

  it('rethrows a notify failure when the send is critical, after logging it', async () => {
    const index = loadSmsTemplateIndex([CONFIGURED]);
    const notify = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const sender = createSmsSender({ notify, getTemplates: () => index, defaultNetwork: null, log });
    await expect(sender.dispatchSms({ caseId: 'profile.create', to: '+91900', critical: true })).rejects.toThrow('boom');
    expect(log).toHaveBeenCalledWith('sms dispatch failed', { caseId: 'profile.create', error: 'boom' });
  });

  it('still skips an unconfigured case when the send is critical', async () => {
    const { sender, notify } = senderWith(CONFIGURED);
    expect(await sender.dispatchSms({ caseId: 'nope', to: '+91900', critical: true })).toEqual({ ok: false, skipped: true });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('getDefaultSmsSender', () => {
  beforeEach(() => resetDefaultSmsSenderForTests());

  it('is null when no notification client is configured', () => {
    client.current = undefined;
    expect(getDefaultSmsSender()).toBeNull();
  });

  it('builds one sender and reuses it', () => {
    client.current = { notify: vi.fn() };
    const sender = getDefaultSmsSender();
    expect(sender).not.toBeNull();
    expect(getDefaultSmsSender()).toBe(sender);
  });
});

describe('smsLink', () => {
  it('reduces an app link to its origin', () => {
    expect(smsLink('https://seekers-purpledots.depwd.gov.in/auth/login')).toBe('https://seekers-purpledots.depwd.gov.in');
  });

  it('is null for a missing or unparseable link', () => {
    expect(smsLink(undefined)).toBeNull();
    expect(smsLink('')).toBeNull();
    expect(smsLink('not a url')).toBeNull();
  });
});
