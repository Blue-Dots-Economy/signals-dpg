import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';
import { isSsrfSafeUrl } from '../ssrf_guard';

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe('isSsrfSafeUrl', () => {
  it('allows a normal public https host', async () => {
    mockLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    expect(await isSsrfSafeUrl('https://example.com/api/v1/event/store')).toBe(true);
  });

  it('rejects non-https schemes', async () => {
    expect(await isSsrfSafeUrl('http://example.com/api/v1/event/store')).toBe(false);
  });

  it('rejects a literal RFC1918 IP in the URL', async () => {
    expect(await isSsrfSafeUrl('https://192.168.1.5/api/v1/event/store')).toBe(false);
  });

  it('rejects the AWS/Azure metadata IP', async () => {
    expect(await isSsrfSafeUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('rejects the GCP metadata hostname', async () => {
    expect(
      await isSsrfSafeUrl('https://metadata.google.internal/computeMetadata/v1/')
    ).toBe(false);
  });

  it('rejects a hostname that resolves to a private IP (DNS rebinding)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.0.0.5', family: 4 });
    expect(await isSsrfSafeUrl('https://rebind.attacker.example/store')).toBe(false);
  });

  it('fails closed when DNS resolution throws', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await isSsrfSafeUrl('https://does-not-resolve.example/store')).toBe(false);
  });

  it('fails closed on a malformed URL', async () => {
    expect(await isSsrfSafeUrl('not-a-url')).toBe(false);
  });
});
