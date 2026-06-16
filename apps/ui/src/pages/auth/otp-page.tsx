import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft, OctagonX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OtpInput } from '@/components/auth/otp-input';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { requestOtp, type AuthIdentifier } from '@/lib/auth-api';
import { useAuth } from '@/contexts/auth-context';
import { getServedBinding } from '@/lib/served-binding';
import { evaluateDomainGate, resolveHeldDomains } from '@/lib/domain-gate';
import { toast } from 'sonner';

interface AuthState extends AuthIdentifier {
  userExists: boolean;
  name?: string;
  redirectTo?: string;
}

function getAuthIdentifier(state: AuthState): AuthIdentifier {
  return state.email ? { email: state.email } : { phoneNumber: state.phoneNumber };
}

export function OtpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { verifyOtp, signOut } = useAuth();
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [inlineError, setInlineError] = useState<{ title: string; description: string } | null>(null);

  const state = location.state as AuthState | null;
  const identifierLabel = state?.email ?? state?.phoneNumber;

  useEffect(() => {
    if (!identifierLabel) {
      navigate('/auth/login');
      return;
    }
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(interval); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [countdown, identifierLabel, navigate]);

  const handleOtpComplete = async (otp: string) => {
    if (!state || !identifierLabel) return;
    setIsLoading(true);
    setInlineError(null);
    try {
      await verifyOtp(getAuthIdentifier(state), otp, state.userExists ? undefined : state.name);

      // Per-domain UI: block a user who already holds a profile in another
      // domain of this network (they must use that domain's portal).
      const binding = getServedBinding();
      if (binding) {
        const held = await resolveHeldDomains(binding.network);
        const gate = evaluateDomainGate(held, binding.domain);
        if (!gate.allow) {
          await signOut();
          navigate('/auth/login', { replace: true, state: { wrongPortalDomain: gate.heldDomain } });
          return;
        }
      }

      toast.success(state.userExists ? t('auth.toast_welcome_back') : t('auth.toast_account_created'), {
        description: state.userExists
          ? t('auth.toast_welcome_back_desc')
          : t('auth.toast_account_created_desc'),
      });
      navigate(state.redirectTo ?? '/', { replace: true });
    } catch {
      setInlineError({
        title: t('auth.otp_incorrect_title'),
        description: t('auth.otp_incorrect_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!state || !identifierLabel || countdown > 0) return;
    setIsLoading(true);
    setInlineError(null);
    try {
      await requestOtp(getAuthIdentifier(state));
      setCountdown(60);
      toast.success(t('auth.toast_new_code_sent'), {
        description: t('auth.toast_new_code_sent_desc'),
      });
    } catch {
      setInlineError({
        title: t('auth.otp_resend_error_title'),
        description: t('auth.otp_resend_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!identifierLabel) return null;

  return (
    <AuthShell>
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/auth/login')}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('auth.back')}
      </button>

      {/* Heading */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-foreground">{t('auth.otp_heading')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('auth.otp_sub')}{' '}
          <span className="font-medium text-foreground">{identifierLabel}</span>
        </p>
      </div>

      {/* OTP input — left-aligned so the box row shares the form column's
          left edge with the "Back" link and "Enter verification code" heading. */}
      <div className="mb-6 flex justify-start">
        <OtpInput onComplete={handleOtpComplete} disabled={isLoading} />
      </div>

      {/* Inline error */}
      {inlineError && (
        <Alert variant="destructive" className="mb-4">
          <OctagonX className="h-4 w-4" />
          <AlertTitle>{inlineError.title}</AlertTitle>
          <AlertDescription>{inlineError.description}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div className="flex justify-center mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      )}

      {/* Resend — left-aligned to match the rest of the form column. */}
      <div className="text-left text-sm">
        {countdown > 0 ? (
          <p className="text-muted-foreground">{t('auth.otp_resend_countdown', { count: countdown })}</p>
        ) : (
          <button
            type="button"
            onClick={handleResendOtp}
            disabled={isLoading}
            className="text-primary hover:underline disabled:opacity-50"
          >
            {t('auth.otp_resend')}
          </button>
        )}
      </div>
    </AuthShell>
  );
}
