import * as React from 'react';

/**
 * Tracks the browser's geolocation PERMISSION state via the Permissions API.
 *
 * The geolocation error code is PERMISSION_DENIED for both a real "block" and a
 * merely-dismissed prompt, so it can't distinguish them. The Permissions API
 * can: it reports 'denied' only on a real block and stays 'prompt' when
 * dismissed. Use 'denied' to decide when re-prompting is futile (hide the
 * "Enable location" button and point the user to browser settings instead).
 *
 * Returns 'unknown' when the Permissions API is unavailable (SSR / older
 * browsers) — callers should treat 'unknown' as "not known to be blocked".
 */
export function useGeolocationPermission(): PermissionState | 'unknown' {
  const [state, setState] = React.useState<PermissionState | 'unknown'>('unknown');

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    const onChange = () => setState(status?.state ?? 'unknown');
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        status = s;
        setState(s.state);
        s.addEventListener('change', onChange);
      })
      .catch(() => setState('unknown'));
    return () => status?.removeEventListener('change', onChange);
  }, []);

  return state;
}
