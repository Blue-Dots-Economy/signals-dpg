import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGeolocationPermission } from '../use-geolocation-permission';

afterEach(() => {
  // Restore a clean navigator.permissions between tests.
  Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
});

describe('useGeolocationPermission', () => {
  it('reflects the resolved permission state', async () => {
    const query = vi.fn().mockResolvedValue({
      state: 'denied' as PermissionState,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(navigator, 'permissions', { value: { query }, configurable: true });

    const { result } = renderHook(() => useGeolocationPermission());
    await waitFor(() => expect(result.current).toBe('denied'));
  });

  it("returns 'unknown' when the Permissions API is unavailable", () => {
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
    const { result } = renderHook(() => useGeolocationPermission());
    expect(result.current).toBe('unknown');
  });
});
