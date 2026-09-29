import { describe, it, expect, vi } from 'vitest';
import type { GuideTour } from '../tours';

vi.mock('../run-tour', () => ({ runTour: vi.fn(), isTourRunning: () => false, hasSeenTour: () => false, markTourSeen: vi.fn() }));
const { autoStartTour } = await import('../guide-button');

const tour = (id: string, path: string, extra: Partial<GuideTour> = {}): GuideTour => ({
  id,
  title: id,
  path,
  matches: (p) => p === path,
  steps: [],
  ...extra,
});
const tours = [
  tour('welcome', '/', { welcome: true, requiresAuth: true }),
  tour('home', '/', { autoStart: true, guestOnly: true }),
  tour('map', '/'),
  tour('my-actions', '/my-actions'),
];
const params = new URLSearchParams();

describe('autoStartTour', () => {
  it('signed out: only a tour marked autoStart plays', () => {
    const who = { isAuthenticated: false, firstLogin: false };
    expect(autoStartTour(tours, '/', params, who)?.id).toBe('home');
    expect(autoStartTour(tours, '/my-actions', params, who)).toBeUndefined();
  });

  it('first-login session: the welcome tour on home, each other page’s own tour elsewhere', () => {
    const who = { isAuthenticated: true, firstLogin: true };
    expect(autoStartTour(tours, '/', params, who)?.id).toBe('welcome');
    expect(autoStartTour(tours, '/my-actions', params, who)?.id).toBe('my-actions');
  });

  it('a returning signed-in user gets no automatic tour — the ? menu still has them', () => {
    const who = { isAuthenticated: true, firstLogin: false };
    expect(autoStartTour(tours, '/', params, who)).toBeUndefined();
    expect(autoStartTour(tours, '/my-actions', params, who)).toBeUndefined();
  });
});
