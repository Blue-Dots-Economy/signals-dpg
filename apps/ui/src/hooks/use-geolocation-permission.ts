import * as React from 'react';

/**
 * Tracks the browser's geolocation permission via the Permissions API. The
 * geolocation error is PERMISSION_DENIED for both a block and a dismissed
 * prompt; the Permissions API reports 'denied' only for a block, which is when
 * re-prompting is futile. Returns 'unknown' when the API is unavailable; treat
 * that as "not known to be blocked".
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
