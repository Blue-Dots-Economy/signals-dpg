import { describe, it, expect, vi } from 'vitest';

describe('submitSupport', () => {
  it('POSTs the full payload to /api/v1/support', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { ok: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitSupport } = await import('../support-api');
    await submitSupport({
      name: 'Asha',
      email: 'asha@example.com',
      phone: '+919000000000',
      type: 'complaint',
      details: 'It broke',
      consent: true,
    });
    expect(post).toHaveBeenCalledWith('/api/v1/support', {
      name: 'Asha',
      email: 'asha@example.com',
      phone: '+919000000000',
      type: 'complaint',
      details: 'It broke',
      consent: true,
    });
  });

  it('omits email and phone when not provided', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { ok: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitSupport } = await import('../support-api');
    await submitSupport({ name: 'Asha', phone: '+919000000000', type: 'support_request', details: 'hi', consent: true });
    expect(post).toHaveBeenCalledWith('/api/v1/support', {
      name: 'Asha',
      phone: '+919000000000',
      type: 'support_request',
      details: 'hi',
      consent: true,
    });
  });
});
