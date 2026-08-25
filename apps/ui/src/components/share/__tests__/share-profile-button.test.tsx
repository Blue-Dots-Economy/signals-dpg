import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareProfileButton } from '../share-profile-button';
import { buildProfileShareUrl } from '@/lib/share-profile';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

// Only the clipboard write is stubbed. `buildProfileShareUrl` stays REAL so the
// dialog's "Copy link" is asserted against the canonical URL the rest of the app
// builds, not against a string this test invented.
const copyMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/share-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/share-profile')>();
  return { ...actual, copyTextToClipboard: (text: string) => copyMock(text) };
});

const liveItem = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '8f14e45f-ceea-467a-9575-28d1b2c3d4e5',
  lifecycle_status: 'live' as const,
};

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  copyMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());

/** Open the share dialog and wait for the QR image to finish encoding. */
async function openDialog() {
  render(<ShareProfileButton item={liveItem} />);
  fireEvent.click(screen.getByRole('button', { name: 'Share profile' }));
  return screen.findByAltText('QR code linking to this profile');
}

describe('ShareProfileButton', () => {
  it('renders nothing for a missing item', () => {
    const { container } = render(<ShareProfileButton item={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-live profile — no share affordance, no QR', () => {
    // The public page only serves LIVE items (`live_only` server-side), so a
    // paused/retired/draft profile must offer nothing to share or scan.
    for (const status of ['draft', 'paused', 'retired'] as const) {
      const { container, unmount } = render(
        <ShareProfileButton item={{ ...liveItem, lifecycle_status: status }} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('button', { name: 'Share profile' })).toBeNull();
      expect(screen.queryByAltText('QR code linking to this profile')).toBeNull();
      unmount();
    }
  });

  it('renders a share button for a live profile, with no dialog until it is clicked', () => {
    render(<ShareProfileButton item={liveItem} />);
    expect(screen.getByRole('button', { name: 'Share profile' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders an optional label next to the icon (public profile page pill)', () => {
    render(<ShareProfileButton item={liveItem} label="Share profile" />);
    expect(screen.getByRole('button', { name: 'Share profile' })).toHaveTextContent(
      'Share profile',
    );
  });

  it('opens a dialog showing the QR and both actions', async () => {
    const img = await openDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QR' })).toBeInTheDocument();
    // The dropped affordance: Firefox cannot write an image to the clipboard.
    expect(screen.queryByRole('button', { name: /copy qr/i })).toBeNull();
  });

  it('"Copy link" copies exactly the URL buildProfileShareUrl produces', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(buildProfileShareUrl(liveItem)));
    expect(toastSuccess).toHaveBeenCalledWith('Link copied to clipboard');
  });

  it('"Copy link" reports failure when the clipboard write fails', async () => {
    copyMock.mockResolvedValueOnce(false);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not copy the link'));
  });

  it('"Download QR" saves a PNG named <network>-<domain>-<itemId>.png', async () => {
    let saved: { href: string; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved = { href: this.getAttribute('href') ?? '', download: this.download };
    });

    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Download QR' }));

    await waitFor(() => expect(saved).not.toBeNull());
    const { href, download } = saved!;
    expect(download).toBe('blue-dot-seeker-8f14e45f-ceea-467a-9575-28d1b2c3d4e5.png');
    // No profile content in the filename: `item_state` is the masked PII.
    expect(href).toMatch(/^data:image\/png;base64,/);
    expect(toastSuccess).toHaveBeenCalledWith('QR code downloaded');
  });
});
