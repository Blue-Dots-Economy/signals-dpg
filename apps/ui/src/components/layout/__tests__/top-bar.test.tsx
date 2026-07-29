import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TopBar } from '../top-bar';

const mockUseAuth = vi.fn();

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/use-actions', () => ({
  usePendingActionsCount: () => ({ data: 0 }),
}));

vi.mock('@/components/auth/user-menu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

function renderBar() {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <TopBar
          search=""
          onSearchChange={() => {}}
          viewMode="map"
          onViewModeChange={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('TopBar search accessibility', () => {
  it('exposes the search input by an accessible name', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderBar();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
  });
});

describe('TopBar mobile decluttering (W1.3)', () => {
  it('hides the inline Language/Theme group on mobile only when authenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar();
    const languageLabel = screen.getByLabelText(/language/i);
    const wrapper = languageLabel.closest('div');
    expect(wrapper).toHaveClass('hidden', 'md:flex');
  });

  it('keeps the inline Language/Theme group visible on mobile when logged out', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderBar();
    const languageLabel = screen.getByLabelText(/language/i);
    const wrapper = languageLabel.closest('div');
    expect(wrapper).not.toHaveClass('hidden');
  });

  it('wraps the inline notification bell so it is md-only when authenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar();
    const bell = screen.getByRole('button', { name: /pending actions/i });
    expect(bell.closest('span')).toHaveClass('hidden', 'md:inline-flex');
  });
});
