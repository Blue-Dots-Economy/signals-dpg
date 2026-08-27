import { describe, it, expect, vi, afterEach } from 'vitest';
import QRCode from 'qrcode';
import {
  PROFILE_QR_OPTIONS,
  buildProfileQrFilename,
  downloadDataUrl,
  generateProfileQrDataUrl,
} from '../profile-qr';
import { buildProfileShareUrl } from '../share-profile';

const item = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '8f14e45f-ceea-467a-9575-28d1b2c3d4e5',
};

describe('PROFILE_QR_OPTIONS', () => {
  it('pins the encoder options every profile QR is rendered with', () => {
    // These values are the feature's contract, not a preference: the rendered
    // image is a pure function of (share URL, these options), so changing any
    // of them silently invalidates every QR already printed on a poster or a
    // badge. Nothing is stored server-side to fall back on.
    expect(PROFILE_QR_OPTIONS).toEqual({
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
    });
  });

  it('is frozen, so no call site can mutate the shared options', () => {
    expect(Object.isFrozen(PROFILE_QR_OPTIONS)).toBe(true);
  });
});

describe('generateProfileQrDataUrl', () => {
  it('produces a PNG data URL', async () => {
    const dataUrl = await generateProfileQrDataUrl(item);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });

  it('is deterministic: generating twice for the same profile yields identical bytes', async () => {
    // THE headline guarantee. Nothing about a QR is persisted — no DB column,
    // no object storage, no server round trip — so "the QR never changes for a
    // profile" holds only if regeneration is byte-identical. Any per-share
    // token, nonce, timestamp or counter smuggled into the encoded URL would
    // break exactly here.
    const first = await generateProfileQrDataUrl(item);
    const second = await generateProfileQrDataUrl(item);
    expect(second).toBe(first);
  });

  it('encodes the canonical share URL, not some other address', async () => {
    // Independently render the URL `buildProfileShareUrl` produces with the
    // pinned options: it must be the very image the app hands out. If the
    // encoded content drifted (extra query param, different path), these differ.
    const expected = await QRCode.toDataURL(buildProfileShareUrl(item), {
      ...PROFILE_QR_OPTIONS,
    });
    expect(await generateProfileQrDataUrl(item)).toBe(expected);
  });

  it('renders a different image for a different profile', async () => {
    // Guards against a degenerate implementation (constant/stub image) that
    // would satisfy the determinism assertion above without encoding anything.
    const other = await generateProfileQrDataUrl({ ...item, item_id: 'aaaaaaaa-0000-0000-0000-000000000000' });
    expect(other).not.toBe(await generateProfileQrDataUrl(item));
  });

  it('renders a different image under different encoder options', async () => {
    // Why the options must be pinned in one place rather than made per-call.
    const withOtherOptions = await QRCode.toDataURL(buildProfileShareUrl(item), {
      errorCorrectionLevel: 'H',
      margin: 4,
      width: 256,
    });
    expect(withOtherOptions).not.toBe(await generateProfileQrDataUrl(item));
  });
});

describe('buildProfileQrFilename', () => {
  it('is <network>-<domain>-<itemId>.png, kebab-cased', () => {
    expect(buildProfileQrFilename(item)).toBe(
      'blue-dot-seeker-8f14e45f-ceea-467a-9575-28d1b2c3d4e5.png',
    );
  });

  it('carries no profile content — only the item key', () => {
    // Every human-readable field (name, title, description) lives in
    // `item_state`, which is exactly what the public projection masks. A
    // name-based filename would leak, via the file on someone's disk, what the
    // public page deliberately hides.
    const named = {
      ...item,
      item_state: { name: 'Asha Kumari', title: 'Nurse' },
    } as Parameters<typeof buildProfileQrFilename>[0] & { item_state: Record<string, unknown> };
    const filename = buildProfileQrFilename(named);
    expect(filename).not.toMatch(/asha|kumari|nurse/i);
    expect(filename).toBe('blue-dot-seeker-8f14e45f-ceea-467a-9575-28d1b2c3d4e5.png');
  });

  it('includes the item id so multiple downloads do not collide', () => {
    const a = buildProfileQrFilename(item);
    const b = buildProfileQrFilename({ ...item, item_id: 'aaaaaaaa-0000-0000-0000-000000000000' });
    expect(a).not.toBe(b);
  });

  it('sanitises segments that are not filename-safe', () => {
    expect(
      buildProfileQrFilename({
        item_network: 'Blue Dot/2',
        item_domain: 'seeker..x',
        item_type: 'profile_1.0',
        item_id: 'ID_42',
      }),
    ).toBe('blue-dot-2-seeker-x-id-42.png');
  });
});

describe('downloadDataUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clicks an anchor carrying the data URL and the download filename, then removes it', () => {
    let seen: { href: string; download: string; inDom: boolean } | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        seen = {
          href: this.getAttribute('href') ?? '',
          download: this.download,
          inDom: this.isConnected,
        };
      });

    downloadDataUrl('data:image/png;base64,AAAA', 'blue-dot-seeker-abc.png');

    expect(click).toHaveBeenCalledOnce();
    expect(seen).toEqual({
      href: 'data:image/png;base64,AAAA',
      download: 'blue-dot-seeker-abc.png',
      // Firefox requires the anchor to be in the document for the click to
      // trigger a download at all.
      inDom: true,
    });
    // …and it must not linger in the DOM afterwards.
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
