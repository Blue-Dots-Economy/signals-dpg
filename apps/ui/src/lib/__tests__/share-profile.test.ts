import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProfileShareUrl, copyTextToClipboard } from '../share-profile';

const item = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '9b545eb9-5406-4bce-bc71-0cdac4b63bd0',
};

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
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });

  it('falls through to textarea when clipboard.writeText rejects and returns true if execCommand succeeds', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });

  it('returns false when execCommand returns false', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockReturnValue(false);
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it('returns false and removes textarea when execCommand throws', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockImplementation(() => {
      throw new Error('execCommand failed');
    });
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(false);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe('buildProfileShareUrl', () => {
  it('builds a /public/<network>/<domain>/<type>/<id>?network= URL from the given origin', () => {
    expect(buildProfileShareUrl(item, 'https://signals.example.org')).toBe(
      'https://signals.example.org/public/blue_dot/seeker/profile_1.0/9b545eb9-5406-4bce-bc71-0cdac4b63bd0?network=blue_dot',
    );
  });

  it('defaults the origin to window.location.origin', () => {
    // jsdom origin is http://localhost:3000 by default
    expect(buildProfileShareUrl(item)).toContain('/public/blue_dot/seeker/profile_1.0/');
    expect(buildProfileShareUrl(item)).toContain('?network=blue_dot');
  });

  it('percent-encodes spaces in item_domain in both path and query params', () => {
    const itemWithSpaceDomain = {
      item_network: 'blue_dot',
      item_domain: 'a b',
      item_type: 'profile_1.0',
      item_id: '12345',
    };
    const url = buildProfileShareUrl(itemWithSpaceDomain, 'https://example.org');
    expect(url).toContain('/public/blue_dot/a%20b/profile_1.0/12345');
    expect(url).toContain('?network=blue_dot');
  });
});
