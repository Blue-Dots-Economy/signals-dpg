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
