import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Explains why the user is on the sign-in screen: `auth-context` redirects
 * here with `?reason=expired` when a session ends mid-use.
 *
 * Its own module because both sign-in panels must render it (each owns its
 * `AuthShell`), and exporting it from `login-page.tsx` would create a circular
 * import with the Keycloak panel. Not a toast: the redirect is a full page
 * navigation, so only the destination can show it.
 */
export function SessionExpiredNotice() {
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  if (searchParams.get('reason') !== 'expired') return null;

  return (
    // `<output>` carries role="status" implicitly (S6819); `block` because it
    // is inline by default.
    <output className="mb-4 block rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      {t('auth.session_expired_desc')}
    </output>
  );
}
