import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UserMenu } from '../user-menu';

const mockUseAuth = vi.fn();
const mockUsePendingActionsCount = vi.fn();

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/use-actions', () => ({
  usePendingActionsCount: () => mockUsePendingActionsCount(),
}));

const mockSupportConfig = vi.fn();
vi.mock('@/hooks/use-support-config', () => ({
  useSupportConfig: () => mockSupportConfig(),
  SUPPORT_CONFIG_FALLBACK: { enabled: true, maxTotalBytes: 5242880, maxFiles: 3, allowedTypes: [] },
}));

const supportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/png'],
  allowedExtensions: ['.png'],
};

const testUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
};

function renderMenu() {
  // UserMenu mounts SupportDialog, which reads its attachment limits through
  // React Query (#551) — hence the provider even though nothing here fetches.
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TooltipProvider>
          <UserMenu />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UserMenu mobile dropdown', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: testUser, signOut: vi.fn() });
    mockUsePendingActionsCount.mockReturnValue({ data: 0 });
    mockSupportConfig.mockReturnValue({ config: supportConfig, isLoading: false });
  });

  it('exposes the mobile-only notifications, language and theme rows once opened', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /ada lovelace|AL/i }));

    // Notifications row (mobile-only, hidden on desktop via md:hidden).
    const notificationsButton = screen.getByRole('button', { name: /notifications/i });
    expect(notificationsButton).toBeInTheDocument();
    expect(notificationsButton.closest('div')).toHaveClass('md:hidden');

    // Language + theme labeled rows.
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();

    // Existing controls stay present.
    expect(screen.getByRole('button', { name: /contact support/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('does not render an avatar dot when there are no pending actions', () => {
    mockUsePendingActionsCount.mockReturnValue({ data: 0 });
    mockSupportConfig.mockReturnValue({ config: supportConfig, isLoading: false });
    const { container } = renderMenu();
    expect(container.querySelector('.md\\:hidden.bg-primary.ring-2')).not.toBeInTheDocument();
  });

  it('renders a mobile-only avatar dot when there are pending actions', () => {
    mockUsePendingActionsCount.mockReturnValue({ data: 3 });
    const { container } = renderMenu();
    const dot = container.querySelector('.ring-2.ring-background');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('md:hidden');
  });
});

describe('UserMenu contact-support entry (#551)', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: testUser, signOut: vi.fn() });
    mockUsePendingActionsCount.mockReturnValue({ data: 0 });
  });

  it('offers Contact support when the instance has support configured', async () => {
    mockSupportConfig.mockReturnValue({
      config: { ...supportConfig, enabled: true },
      isLoading: false,
    });
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /ada lovelace|AL/i }));
    expect(screen.getByRole('button', { name: /contact support/i })).toBeInTheDocument();
  });

  it('hides it when support is unconfigured, instead of 503ing after the user types', async () => {
    mockSupportConfig.mockReturnValue({
      config: { ...supportConfig, enabled: false },
      isLoading: false,
    });
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /ada lovelace|AL/i }));
    expect(screen.queryByRole('button', { name: /contact support/i })).not.toBeInTheDocument();
  });
});
