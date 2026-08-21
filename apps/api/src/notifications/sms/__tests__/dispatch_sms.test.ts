import { describe, expect, it, vi } from 'vitest';
import { createSmsSender, type SmsNotifyRequest } from '../dispatch_sms';
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

  it('never throws — a notify failure is swallowed and reported as not-ok', async () => {
    const index = loadSmsTemplateIndex([CONFIGURED]);
    const notify = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const sender = createSmsSender({ notify, getTemplates: () => index, defaultNetwork: null, log });
    const res = await sender.dispatchSms({ caseId: 'profile.create', to: '+91900' });
    expect(res).toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith('sms dispatch failed', expect.objectContaining({ caseId: 'profile.create' }));
  });
});
