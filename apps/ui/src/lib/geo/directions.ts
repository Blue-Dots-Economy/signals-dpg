import type { LatLng } from './types';

export type PlatformKind = 'android' | 'ios' | 'other';

/** Classifies the platform from a user-agent string. */
export function detectPlatform(userAgent: string): PlatformKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'other';
}

/**
 * Directions deep link to `dest`: a `geo:` URI on Android (OS map-app chooser),
 * an Apple Maps universal link on iOS, a Google Maps directions URL otherwise.
 */
export function directionsUrl(dest: LatLng, label: string | undefined, platform: PlatformKind): string {
  const { lat, lng } = dest;
  switch (platform) {
    case 'android': {
      const encodedLabel = label
        ? encodeURIComponent(label).replaceAll('(', '%28').replaceAll(')', '%29')
        : '';
      const q = label ? `${lat},${lng}(${encodedLabel})` : `${lat},${lng}`;
      return `geo:${lat},${lng}?q=${q}`;
    }
    case 'ios':
      return `https://maps.apple.com/?daddr=${lat},${lng}`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
}

/** Build a `tel:` href. A bare 10-digit number gets the default country code. */
export function telHref(phone: string, defaultCountryCode = '+91'): string {
  const cleaned = phone.replaceAll(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return `tel:${cleaned}`;
  if (/^\d{10}$/.test(cleaned)) return `tel:${defaultCountryCode}${cleaned}`;
  return `tel:${cleaned}`;
}

/** Ensure a website URL has a scheme so it opens as an absolute link. */
export function normalizeWebsiteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Opens directions to `dest`. Mobile navigates the current tab so the OS can
 * hand off to a native maps app; desktop opens a new tab.
 */
export function openDirections(dest: LatLng, label: string | undefined, win: Window = window): void {
  const platform = detectPlatform(win.navigator.userAgent);
  const url = directionsUrl(dest, label, platform);
  if (platform === 'other') {
    win.open(url, '_blank', 'noopener,noreferrer');
  } else {
    win.location.assign(url);
  }
}
