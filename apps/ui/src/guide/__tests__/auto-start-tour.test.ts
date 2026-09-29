import { describe, it, expect, vi } from 'vitest';
import type { GuideTour } from '../tours';

vi.mock('../run-tour', () => ({ runTour: vi.fn(), isTourRunning: () => false, hasSeenTour: () => false, markTourSeen: vi.fn() }));
const { autoStartTour } = await import('../guide-button');

const tour = (id: string, path: string, autoStart = false): GuideTour => ({
  id,
  title: id,
  path,
  matches: (p) => p === path,
  autoStart,
  steps: [],
});
const tours = [tour('home', '/', true), tour('my-actions', '/my-actions')];
const params = new URLSearchParams();

describe('autoStartTour', () => {
  it('signed out: only a tour marked autoStart plays', () => {
    const who = { isAuthenticated: false, firstLogin: false };
    expect(autoStartTour(tours, '/', params, who)?.id).toBe('home');
    expect(autoStartTour(tours, '/my-actions', params, who)).toBeUndefined();
  });

  it('first-login session: each page’s tour plays', () => {
    const who = { isAuthenticated: true, firstLogin: true };
    expect(autoStartTour(tours, '/', params, who)?.id).toBe('home');
    expect(autoStartTour(tours, '/my-actions', params, who)?.id).toBe('my-actions');
  });

  it('a returning signed-in user gets no automatic tour — the ? menu still has them', () => {
    const who = { isAuthenticated: true, firstLogin: false };
    expect(autoStartTour(tours, '/', params, who)).toBeUndefined();
    expect(autoStartTour(tours, '/my-actions', params, who)).toBeUndefined();
  });
});
