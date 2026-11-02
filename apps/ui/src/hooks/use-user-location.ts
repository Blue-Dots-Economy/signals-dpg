import * as React from 'react';
import {
  useBrowserLocation,
  type UseBrowserLocationReturn,
} from '@/hooks/use-browser-location';
import type { LatLng } from '@/lib/geo/types';

export type UserLocationSource = 'profile' | 'browser' | 'none';

/** The location source a user can explicitly ask for via the toggle. */
export type PreferredLocationSource = 'profile' | 'browser';

export interface ResolvedUserLocation {
  location: LatLng | null;
  source: UserLocationSource;
  /** The underlying browser-location hook, so callers can drive permission UI. */
  browser: UseBrowserLocationReturn;
}

/**
 * Resolves the location used for "nearby" features.
 *
 * `preferredSource` (default 'profile') picks which of the profile location and
 * browser geolocation wins; each falls back to the other.
 *
 * The browser location is requested when there is no profile location (once
 * `profileResolved`, so a user with one isn't prompted during profile load), or
 * when 'browser' is preferred, which fires from the toggle's user gesture.
 */
export function useUserLocation(
  profileLocation: LatLng | null,
  profileResolved: boolean,
  preferredSource: PreferredLocationSource = 'profile',
): ResolvedUserLocation {
  const browser = useBrowserLocation();

  const wantsBrowser =
    preferredSource === 'browser' || (profileResolved && !profileLocation);

  React.useEffect(() => {
    if (wantsBrowser && browser.isSupported && browser.status === 'idle') {
      // Errors surface via browser.status / browser.error; void is intentional.
      void browser.request();
    }
  }, [wantsBrowser, browser.isSupported, browser.status, browser.request]);

  const browserLatLng: LatLng | null = browser.location
    ? { lat: browser.location.lat, lng: browser.location.lng }
    : null;

  let location: LatLng | null;
  let source: UserLocationSource;
  if (preferredSource === 'browser') {
    location = browserLatLng ?? profileLocation;
    source = browserLatLng ? 'browser' : profileLocation ? 'profile' : 'none';
  } else {
    location = profileLocation ?? browserLatLng;
    source = profileLocation ? 'profile' : browserLatLng ? 'browser' : 'none';
  }

  return { location, source, browser };
}
