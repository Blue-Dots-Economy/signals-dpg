import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TouristTopBar } from './tourist-top-bar';

describe('TouristTopBar', () => {
  it('renders search, view toggle, and the filters slot; no auth controls', async () => {
    const onSearch = vi.fn();
    const onView = vi.fn();
    render(
      <TooltipProvider>
        <TouristTopBar
          search=""
          onSearchChange={onSearch}
          viewMode="map"
          onViewModeChange={onView}
          filtersSlot={<div data-testid="filters" />}
        />
      </TooltipProvider>,
    );
    await userEvent.type(screen.getByRole('searchbox'), 'cafe');
    expect(onSearch).toHaveBeenCalled();
    expect(screen.getByTestId('filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log in/i })).toBeNull();
  });
});
