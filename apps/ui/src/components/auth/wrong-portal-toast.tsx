import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { takePendingWrongPortal } from '@/lib/pending-wrong-portal';

/**
 * Surfaces the `auth.wrong_portal` explanation after a domain-gate bounce that
 * crossed a full page load.
 *
 * Mounted app-wide rather than on `/auth/login`, because the Keycloak logout
 * redirect returns the browser to `postLogoutRedirectUri` — the site root —
 * not to the login page. See `lib/pending-wrong-portal.ts` for why router
 * state cannot carry this on the Keycloak path.
 *
 * Shares the `wrong-portal-block` toast id with `login-page`'s router-state
 * path, so on the better-auth flow (where both could fire) sonner shows one
 * toast rather than two.
 */
export function WrongPortalToast() {
  const { t } = useTranslation();

  useEffect(() => {
    const domain = takePendingWrongPortal();
    if (!domain) return;
    toast.error(t('auth.wrong_portal', { domain }), { id: 'wrong-portal-block' });
    // `t` is deliberately absent from the deps: the read is one-shot, so a
    // language change re-running this effect would find nothing and silently
    // swallow the message the user has not read yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
