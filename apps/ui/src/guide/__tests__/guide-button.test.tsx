import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GuideTour } from '../tours';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

const runTour = vi.fn(async (_tour: GuideTour) => {});
vi.mock('../run-tour', () => ({
  runTour: (t: GuideTour) => runTour(t),
  isTourRunning: () => false,
  hasSeenTour: () => false,
  markTourSeen: vi.fn(),
}));

const myActionsTour: GuideTour = {
  id: 'my-actions',
  title: 'My actions',
  path: '/my-actions',
  matches: (p) => p === '/my-actions',
  steps: [],
};
vi.mock('../tours', () => ({
  TOURS: [myActionsTour],
  findTour: (id: string) => (id === myActionsTour.id ? myActionsTour : undefined),
}));

const { GuideButton } = await import('../guide-button');

describe('GuideButton ?tour= deep link', () => {
  it('opens the tour’s own page when the link points at a tour for another page', async () => {
    render(
      <MemoryRouter initialEntries={['/?tour=my-actions']}>
        <GuideButton />
      </MemoryRouter>,
    );

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/my-actions', { replace: true }));
    expect(runTour).toHaveBeenCalledWith(myActionsTour);
  });
});
