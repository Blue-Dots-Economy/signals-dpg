import { OctagonX } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * Where a refused partner-portal SSO login lands
 * (`/auth/sso/error?reason=<code>`, set by the API's /sso routes).
 *
 * Only a fixed set of reason codes is recognised; anything else reads as the
 * generic message, so a crafted `reason` can never put text of its choosing on
 * the page. The way out is back to the partner — they hold the user's login,
 * and a fresh link from there is the fix for almost every reason here.
 */
const KNOWN_REASONS = new Set([
  'link-invalid',
  'link-expired',
  'link-reused',
  'provider-unavailable',
  'account-inactive',
  'phone-unverified',
  'link-conflict',
  'session-expired',
]);

export function SsoErrorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const raw = searchParams.get('reason') ?? '';
  const reason = KNOWN_REASONS.has(raw) ? raw : 'unknown';
  const partnerUrl = getRuntimeEnv('VITE_SSO_PARTNER_URL');
  const partnerName = getRuntimeEnv('VITE_SSO_PARTNER_NAME') || t('auth.sso_partner_default');

  return (
    <AuthShell>
      <div className="mx-auto flex max-w-md flex-col gap-4 py-16">
        <Alert variant="destructive">
          <OctagonX className="size-4" />
          <AlertTitle>{t('auth.sso_error_title')}</AlertTitle>
          <AlertDescription>{t(`auth.sso_error_${reason.replace(/-/g, '_')}`)}</AlertDescription>
        </Alert>
        {partnerUrl ? (
          <Button asChild>
            <a href={partnerUrl} rel="noopener noreferrer">
              {t('auth.sso_back_to_partner', { partner: partnerName })}
            </a>
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => navigate('/', { replace: true })}>
          {t('auth.sso_go_home')}
        </Button>
      </div>
    </AuthShell>
  );
}
