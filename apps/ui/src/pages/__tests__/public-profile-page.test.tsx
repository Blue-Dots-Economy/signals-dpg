import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublicProfilePage } from '../public-profile-page';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

const useItemDetail = vi.fn();
vi.mock('@/hooks/use-item-detail', () => ({ useItemDetail: (...a: unknown[]) => useItemDetail(...a) }));

const resolvedNetwork = {
  id: 'blue_dot',
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

const useAuth = vi.fn();
vi.mock('@/contexts/auth-context', () => ({ useAuth: (...a: unknown[]) => useAuth(...a) }));

const useMyItems = vi.fn();
vi.mock('@/hooks/use-my-items', () => ({ useMyItems: (...a: unknown[]) => useMyItems(...a) }));

vi.mock('@/components/layout/sidebar', () => ({
  AppSidebar: () => <div data-testid="app-sidebar">My Profiles</div>,
}));
vi.mock('@/components/layout/portal-header', () => ({
  PortalHeader: () => <div data-testid="portal-header">Blue Dots</div>,
}));
vi.mock('@/components/auth/user-menu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));
vi.mock('@/components/layout/theme-mode-toggle', () => ({
  ThemeModeToggle: () => <div data-testid="theme-toggle" />,
}));

const ID = '9b545eb9-5406-4bce-bc71-0cdac4b63bd0';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/public/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper },
  );
}

beforeEach(() => {
  useResolvedNetwork.mockReturnValue({ data: resolvedNetwork, isLoading: false, isError: false });
  useItemDetail.mockReset();
  useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });
  useMyItems.mockReturnValue({ data: [], isLoading: false, isFetched: true });
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
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    expect(screen.getByText('City')).toBeInTheDocument();
    expect(screen.getByText('Pune')).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: true, isError: false });
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Loading profile…')).toBeInTheDocument();
  });

  it('shows unavailable when the item is empty', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });

  it('shows the error state on a transient error', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: true });
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows unavailable for a malformed item id (no fetch)', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt('/public/blue_dot/seeker/profile_1.0/not-a-uuid');
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });

  it('anonymous mode shows Explore more + Sign in, and no My Profiles sidebar', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });
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
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Explore more')).toBeInTheDocument();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.queryByText('My Profiles')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('portal-header')).toBeInTheDocument();
  });

  it('logged-in viewing own profile shows the own-preview banner', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, user: { id: 'u1', name: 'Asha' } });
    useMyItems.mockReturnValue({
      data: [
        {
          item_id: ID,
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: { name: 'Asha', city: 'Pune' },
          lifecycle_status: 'live',
        },
      ],
      isLoading: false,
      isFetched: true,
    });
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
    renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
    expect(
      screen.getByText(
        'This is the public view others see when you share your profile — contact details stay hidden until someone connects.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu')).toBeInTheDocument();
  });
});
