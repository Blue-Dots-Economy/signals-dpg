import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { takePendingWrongPortal } from '@/lib/pending-wrong-portal';

/**
 * Shows the `auth.wrong_portal` message after a domain-gate bounce that
 * crossed a full page load. Mounted app-wide because the Keycloak logout
 * redirect returns to the site root (`postLogoutRedirectUri`), not the login
 * page; see `lib/pending-wrong-portal.ts`.
 *
 * Uses the shared `wrong-portal-block` toast id so sonner never shows the
 * message twice.
 */
export function WrongPortalToast() {
  const { t } = useTranslation();

  useEffect(() => {
    const domain = takePendingWrongPortal();
    if (!domain) return;
    toast.error(t('auth.wrong_portal', { domain }), { id: 'wrong-portal-block' });
    // `t` is not a dependency: the read is one-shot, so a re-run on language
    // change would find nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
