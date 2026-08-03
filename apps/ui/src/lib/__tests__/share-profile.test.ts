import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProfileShareUrl, copyTextToClipboard } from '../share-profile';

const item = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '9b545eb9-5406-4bce-bc71-0cdac4b63bd0',
};

describe('buildProfileShareUrl', () => {
  it('builds a /p/<network>/<domain>/<type>/<id>?network= URL from the given origin', () => {
    expect(buildProfileShareUrl(item, 'https://signals.example.org')).toBe(
      'https://signals.example.org/p/blue_dot/seeker/profile_1.0/9b545eb9-5406-4bce-bc71-0cdac4b63bd0?network=blue_dot',
    );
  });

  it('defaults the origin to window.location.origin', () => {
    // jsdom origin is http://localhost:3000 by default
    expect(buildProfileShareUrl(item)).toContain('/p/blue_dot/seeker/profile_1.0/');
    expect(buildProfileShareUrl(item)).toContain('?network=blue_dot');
  });
});

describe('copyTextToClipboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.unstubAllGlobals();
  });

  it('falls back to execCommand when the Clipboard API is absent', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockReturnValue(true);
    // @ts-expect-error test shim
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });
});
