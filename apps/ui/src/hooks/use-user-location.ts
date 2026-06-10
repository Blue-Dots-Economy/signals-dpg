import * as React from 'react';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import type { LatLng } from '@/lib/geo/types';

export type UserLocationSource = 'profile' | 'browser' | 'none';

export interface ResolvedUserLocation {
  location: LatLng | null;
  source: UserLocationSource;
}

/**
 * Resolves the location used for "nearby" features, by priority:
 *  1. profileLocation (the logged-in user's active-profile location), when present
 *  2. else the browser geolocation (auto-requested once, when there's no profile location)
 *  3. else null (caller falls back to a default view)
 *
 * Auto-prompts for browser location ONLY when there is no profile location — so a
 * visitor / a profile whose domain has no location field / a user with no profile
 * triggers the browser permission prompt, while a profile with a location never does.
 */
export function useUserLocation(profileLocation: LatLng | null): ResolvedUserLocation {
  const browser = useBrowserLocation();

  React.useEffect(() => {
    if (!profileLocation && browser.isSupported && browser.status === 'idle') {
      // Errors surface via browser.status / browser.error inside useBrowserLocation; void is intentional.
      void browser.request();
    }
  }, [profileLocation, browser.isSupported, browser.status, browser.request]);

  const location: LatLng | null =
    profileLocation ??
    (browser.location ? { lat: browser.location.lat, lng: browser.location.lng } : null);

  const source: UserLocationSource = profileLocation
    ? 'profile'
    : browser.location
      ? 'browser'
      : 'none';

  return { location, source };
}
