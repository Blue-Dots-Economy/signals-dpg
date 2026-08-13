import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareProfileButton } from '../share-profile-button';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));
const copyMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/share-profile', () => ({
  buildProfileShareUrl: () => 'https://x/p/blue_dot/seeker/profile_1.0/abc?network=blue_dot',
  copyTextToClipboard: (t: string) => copyMock(t),
}));

const liveItem = {
  item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0',
  item_id: 'abc', lifecycle_status: 'live' as const,
};

beforeEach(() => { toastSuccess.mockClear(); toastError.mockClear(); copyMock.mockClear(); });

describe('ShareProfileButton', () => {
  it('renders nothing for a missing item', () => {
    const { container } = render(<ShareProfileButton item={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-live profile', () => {
    const { container } = render(<ShareProfileButton item={{ ...liveItem, lifecycle_status: 'paused' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a button for a live profile and copies + toasts on click', async () => {
    render(<ShareProfileButton item={liveItem} />);
    const btn = screen.getByRole('button', { name: 'Share profile' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith('https://x/p/blue_dot/seeker/profile_1.0/abc?network=blue_dot'),
    );
    expect(toastSuccess).toHaveBeenCalledWith('Link copied to clipboard');
  });
});
