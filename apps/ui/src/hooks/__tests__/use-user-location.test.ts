import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockBrowser = vi.hoisted(() => ({
  location: null as { lat: number; lng: number; accuracy: number } | null,
  status: 'idle' as 'idle' | 'loading' | 'success' | 'error',
  error: null,
  isSupported: true,
  request: vi.fn(() => Promise.resolve(null)),
  reset: vi.fn(),
}));

vi.mock('@/hooks/use-browser-location', () => ({
  useBrowserLocation: () => mockBrowser,
}));

import { useUserLocation } from '../use-user-location';

const PROFILE = { lat: 22.3, lng: 70.8 };
const BROWSER = { lat: 23.0, lng: 72.6, accuracy: 20 };

beforeEach(() => {
  mockBrowser.location = null;
  mockBrowser.status = 'idle';
  mockBrowser.request.mockClear();
});

describe('useUserLocation', () => {
  it("prefers the profile location when preferredSource is 'profile'", () => {
    mockBrowser.location = BROWSER;
    mockBrowser.status = 'success';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'profile'));
    expect(result.current.location).toEqual(PROFILE);
    expect(result.current.source).toBe('profile');
  });

  it("uses the browser location when preferredSource is 'browser'", () => {
    mockBrowser.location = BROWSER;
    mockBrowser.status = 'success';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(result.current.location).toEqual({ lat: BROWSER.lat, lng: BROWSER.lng });
    expect(result.current.source).toBe('browser');
  });

  it("falls back to the profile location when browser is preferred but unavailable", () => {
    mockBrowser.location = null;
    mockBrowser.status = 'error';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(result.current.location).toEqual(PROFILE);
    expect(result.current.source).toBe('profile');
  });

  it('auto-requests the browser location when there is no profile location', () => {
    renderHook(() => useUserLocation(null, true, 'profile'));
    expect(mockBrowser.request).toHaveBeenCalled();
  });

  it('requests the browser location when browser is explicitly preferred and idle', () => {
    renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(mockBrowser.request).toHaveBeenCalled();
  });
});
