/**
 * Browser geolocation helper: a typed, promise-based wrapper around the
 * `navigator.geolocation` API with explicit error codes. Framework-agnostic so
 * it can back a hook, a map "locate me" control, or a nearby-search flow.
 *
 * NOTE: `getCurrentPosition` triggers the browser's permission prompt and should
 * be invoked from a user gesture (e.g. a button click) — never on mount.
 */

export interface BrowserLocation {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Accuracy radius of the reported position, in metres. */
  accuracy: number;
}

export type BrowserLocationErrorCode =
  | 'unsupported' // navigator.geolocation not available (SSR / old browser)
  | 'permission_denied' // user blocked the permission prompt
  | 'position_unavailable' // device could not determine a fix
  | 'timeout'; // gave up before a fix arrived (or the request was aborted)

export class BrowserLocationError extends Error {
  readonly code: BrowserLocationErrorCode;

  constructor(code: BrowserLocationErrorCode, message: string) {
    super(message);
    this.name = 'BrowserLocationError';
    this.code = code;
  }
}

export interface GetBrowserLocationOptions {
  /** Request the most precise fix (GPS). Slower and more battery. Default false. */
  highAccuracy?: boolean;
  /** Give up after this many milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Accept a cached fix up to this many milliseconds old. Default 0 (always fresh). */
  maxAgeMs?: number;
  /** Optional abort signal to reject a pending request early. */
  signal?: AbortSignal;
}

/** True when the current environment can resolve a browser location. */
export function isBrowserLocationSupported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/**
 * Resolves the user's current location, or rejects with a {@link BrowserLocationError}
 * carrying a discriminated `code` the caller can branch on (e.g. show a
 * "permission denied" hint vs a generic retry).
 */
export function getBrowserLocation(
  options: GetBrowserLocationOptions = {}
): Promise<BrowserLocation> {
  const { highAccuracy = false, timeoutMs = 10_000, maxAgeMs = 0, signal } = options;

  return new Promise<BrowserLocation>((resolve, reject) => {
    if (!isBrowserLocationSupported()) {
      reject(
        new BrowserLocationError('unsupported', 'Geolocation is not available in this browser.')
      );
      return;
    }

    if (signal?.aborted) {
      reject(new BrowserLocationError('timeout', 'Location request was aborted.'));
      return;
    }

    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new BrowserLocationError('timeout', 'Location request was aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(toBrowserLocationError(error));
      },
      { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maxAgeMs }
    );
  });
}

function toBrowserLocationError(error: GeolocationPositionError): BrowserLocationError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return new BrowserLocationError('permission_denied', 'Location permission was denied.');
    case error.POSITION_UNAVAILABLE:
      return new BrowserLocationError(
        'position_unavailable',
        'Your location could not be determined.'
      );
    case error.TIMEOUT:
      return new BrowserLocationError('timeout', 'Timed out while determining your location.');
    default:
      return new BrowserLocationError(
        'position_unavailable',
        error.message || 'Failed to get the current location.'
      );
  }
}
