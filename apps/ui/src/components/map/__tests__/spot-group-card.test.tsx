import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OpenSpotGroup } from '@/engine/types';
import { SpotGroupCard } from '../spot-group-card';

const group = (overrides: Partial<OpenSpotGroup> = {}): OpenSpotGroup => ({
  key: 'c:1',
  count: 1400,
  breakdown: [
    { domain: 'provider', count: 1200 },
    { domain: 'service_provider', count: 200 },
  ],
  exact: true,
  bounds: { minLat: 13.3409, minLng: 77.101, maxLat: 13.3409, maxLng: 77.101 },
  ...overrides,
});

describe('SpotGroupCard', () => {
  it('explains listings that share one exact spot', () => {
    render(<SpotGroupCard group={group()} />);
    expect(screen.getByText('1,400 listings at this exact spot')).toBeInTheDocument();
    expect(screen.getByText(/share one location/)).toBeInTheDocument();
  });

  it('explains listings that are only very close together', () => {
    render(<SpotGroupCard group={group({ exact: false })} />);
    expect(screen.getByText('1,400 listings very close together')).toBeInTheDocument();
    expect(screen.getByText(/too close together/)).toBeInTheDocument();
  });

  it('shows the count for each listing type', () => {
    render(<SpotGroupCard group={group()} formatDomain={(d) => (d === 'provider' ? 'Provider' : 'Service Provider')} />);
    expect(screen.getByText('1,200 Provider')).toBeInTheDocument();
    expect(screen.getByText('200 Service Provider')).toBeInTheDocument();
  });

  it('opens the list from its button', async () => {
    const onView = vi.fn();
    render(<SpotGroupCard group={group()} onView={onView} />);
    await userEvent.click(screen.getByRole('button', { name: 'View these 1,400 in the list' }));
    expect(onView).toHaveBeenCalledWith(group());
  });

  it('has no list button when nothing can open the list', () => {
    render(<SpotGroupCard group={group()} />);
    expect(screen.queryByRole('button', { name: /in the list/ })).not.toBeInTheDocument();
  });
});
