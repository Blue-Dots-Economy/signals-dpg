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
 * `preferredSource` is the user's explicit choice (default 'profile'):
 *  - 'profile' → the active profile's location, falling back to the browser
 *    location when the profile has none.
 *  - 'browser' → the browser geolocation, falling back to the profile location
 *    when the browser one isn't available (denied / not yet resolved).
 *
 * Two prompt triggers:
 *  1. Auto-prompt (unchanged): when there is NO profile location, the browser
 *     location is auto-requested once so a visitor / location-less profile still
 *     gets nearby results without an explicit action.
 *  2. Explicit prompt: when 'browser' is preferred and the browser status is
 *     idle, request it — this fires from the toggle's user gesture even when a
 *     profile location exists.
 *
 * `profileResolved` gates the auto-prompt so a logged-in user with a profile
 * location isn't prompted during the async profile-load window.
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
