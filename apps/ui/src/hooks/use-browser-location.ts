import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBrowserLocation,
  isBrowserLocationSupported,
  BrowserLocationError,
  type BrowserLocation,
  type GetBrowserLocationOptions,
} from '@/lib/geo/browser-location';

export type BrowserLocationStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseBrowserLocationReturn {
  /** Last resolved location, or null until a successful `request()`. */
  location: BrowserLocation | null;
  status: BrowserLocationStatus;
  error: BrowserLocationError | null;
  /** Whether this browser exposes the geolocation API at all. */
  isSupported: boolean;
  /**
   * Request the current location. MUST be called from a user gesture (a click) —
   * geolocation prompts for permission. Resolves to the location, or null if it
   * failed/was denied (in which case `error`/`status` are also set).
   */
  request: (options?: GetBrowserLocationOptions) => Promise<BrowserLocation | null>;
  /** Clear state and cancel any in-flight request. */
  reset: () => void;
}

/**
 * React wrapper around {@link getBrowserLocation}. Nothing runs on mount; call
 * `request()` from a click handler and render against `status`/`error`. A new
 * `request()` cancels any in-flight one, and an unmount aborts it.
 */
export function useBrowserLocation(): UseBrowserLocationReturn {
  const [location, setLocation] = useState<BrowserLocation | null>(null);
  const [status, setStatus] = useState<BrowserLocationStatus>('idle');
  const [error, setError] = useState<BrowserLocationError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const request = useCallback(async (options?: GetBrowserLocationOptions) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('loading');
    setError(null);

    try {
      const result = await getBrowserLocation({ ...options, signal: controller.signal });
      if (controller.signal.aborted) return null;
      setLocation(result);
      setStatus('success');
      return result;
    } catch (err) {
      if (controller.signal.aborted) return null;
      const locationError =
        err instanceof BrowserLocationError
          ? err
          : new BrowserLocationError('position_unavailable', 'Failed to get the current location.');
      setError(locationError);
      setStatus('error');
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setLocation(null);
    setStatus('idle');
    setError(null);
  }, []);

  return {
    location,
    status,
    error,
    isSupported: isBrowserLocationSupported(),
    request,
    reset,
  };
}
