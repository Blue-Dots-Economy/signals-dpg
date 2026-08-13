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
