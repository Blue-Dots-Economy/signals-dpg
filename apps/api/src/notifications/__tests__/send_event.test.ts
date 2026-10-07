import { describe, expect, it, vi } from 'vitest';
import { NotifyTransportError, type NotifyEvent } from '@dpg/notification';

import { sendBestEffort } from '../send_event';

const EVENT: NotifyEvent = {
  event_type: 'item.created',
  domain: 'seeker',
  to: { email: 'a@x.com' },
  variables: { name: 'Asha', ctaUrl: 'https://s.test/login', teamName: 'EkStep' },
  priority: 'normal',
  idempotency_key: 'item_lifecycle:item.created:u1',
};

describe('sendBestEffort', () => {
  it('returns true on an accepted send and logs nothing', async () => {
    const log = vi.fn();
    const send = vi.fn(async () => ({
      ok: true as const,
      status: 202 as const,
      body: { notification_event_id: 'ne', correlation_id: 'c' },
    }));

    await expect(sendBestEffort(send, EVENT, log)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(EVENT);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a 422 from NS as ns_rejected with the NS error code and swallows it', async () => {
    const log = vi.fn();
    const send = vi.fn(async () => ({
      ok: false as const,
      status: 422,
      error: 'missing_variable',
      kind: 'caller' as const,
    }));

    await expect(sendBestEffort(send, EVENT, log, { op: 'create' })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('ns_rejected', {
      event_type: 'item.created',
      domain: 'seeker',
      status: 422,
      error: 'missing_variable',
      kind: 'caller',
      op: 'create',
    });
  });

  it('logs a transport error as ns_unreachable and swallows it', async () => {
    const log = vi.fn();
    const send = vi.fn(async () => {
      throw new NotifyTransportError('fetch failed: TypeError');
    });

    await expect(sendBestEffort(send, EVENT, log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('ns_unreachable', {
      event_type: 'item.created',
      domain: 'seeker',
      error: 'fetch failed: TypeError',
    });
  });

  it('never logs the recipient or variable values', async () => {
    const log = vi.fn();
    const send = vi.fn(async () => ({ ok: false as const, status: 500, error: 'http_500' }));

    await sendBestEffort(send, EVENT, log);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('a@x.com');
    expect(logged).not.toContain('Asha');
  });

  it('rethrows an unexpected error for the caller to handle', async () => {
    const send = vi.fn(async () => {
      throw new Error('bug');
    });
    await expect(sendBestEffort(send, EVENT, vi.fn())).rejects.toThrow('bug');
  });
});
