import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PublicProfilePage } from '../public-profile-page';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

const useItemDetail = vi.fn();
vi.mock('@/hooks/use-item-detail', () => ({ useItemDetail: (...a: unknown[]) => useItemDetail(...a) }));

const resolvedNetwork = {
  display_name: 'Blue Dot',
  domains: [
    {
      id: 'seeker',
      description: 'seekers',
      card: { title_field: 'name' },
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: { name: { type: 'string', title: 'Name' }, city: { type: 'string', title: 'City' } },
        },
      },
    },
  ],
};
const useResolvedNetwork = vi.fn();
vi.mock('@/hooks/use-network-config', () => ({ useResolvedNetwork: (...a: unknown[]) => useResolvedNetwork(...a) }));

const ID = '9b545eb9-5406-4bce-bc71-0cdac4b63bd0';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/p/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useResolvedNetwork.mockReturnValue({ data: resolvedNetwork, isLoading: false, isError: false });
  useItemDetail.mockReset();
});

describe('PublicProfilePage', () => {
  it('renders the resolved title and field labels for a live item', () => {
    useItemDetail.mockReturnValue({
      item: {
        item_id: ID,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { name: 'Asha', city: 'Pune' },
        lifecycle_status: 'live',
      },
      isLoading: false,
      isError: false,
    });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    expect(screen.getByText('City')).toBeInTheDocument();
    expect(screen.getByText('Pune')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: true, isError: false });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Loading profile…')).toBeInTheDocument();
  });

  it('shows unavailable when the item is empty', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });

  it('shows the error state on a transient error', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: true });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows unavailable for a malformed item id (no fetch)', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt('/p/blue_dot/seeker/profile_1.0/not-a-uuid');
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });
});
