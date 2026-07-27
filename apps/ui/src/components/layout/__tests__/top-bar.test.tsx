import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TopBar } from '../top-bar';

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
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
    renderBar();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
  });
});
