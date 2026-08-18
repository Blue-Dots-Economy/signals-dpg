import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useResendCountdown } from '@/hooks/use-resend-countdown';
import { Loader2, ArrowLeft, OctagonX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OtpInput } from '@/components/auth/otp-input';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { requestOtp, type AuthIdentifier } from '@/lib/auth-api';
import { useAuth } from '@/contexts/auth-context';
import { getServedScope } from '@/lib/served-binding';
import { evaluateDomainGate, resolveHeldDomains } from '@/lib/domain-gate';
import { toast } from 'sonner';
import { acceptConsent, submitU18Dob, getU18Status } from '@/lib/consent-api';
import type { ConsentAcceptBody } from '@dpg/schemas';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { useNetworkTheme } from '@/theme/theme-provider';
import { setStoredSignupDomain, type SignupExtras } from '@/lib/signup-domain';
import { setUserDomains } from '@/lib/user-api';
import { resolvePostLoginLanding } from '@/lib/post-login-landing';

interface AuthState extends AuthIdentifier {
  userExists: boolean;
  name?: string;
  redirectTo?: string;
  pendingConsent?: ConsentAcceptBody | null;
  /** Carries the age (+ chosen domain for new signups) captured in the auth
   * flow before this OTP: set for a brand-new signup, and for an existing minor
   * who picked their year of birth pre-OTP (see login-page.tsx). Null otherwise. */
  signupExtras?: SignupExtras | null;
}

function getAuthIdentifier(state: AuthState): AuthIdentifier {
  return state.email ? { email: state.email } : { phoneNumber: state.phoneNumber };
}

export function OtpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { verifyOtp, signOut } = useAuth();
  const { t } = useTranslation();
  const { themeId, brand } = useNetworkTheme();
  const [isLoading, setIsLoading] = useState(false);
  const { countdown, restart: restartCountdown } = useResendCountdown(60);
  const [inlineError, setInlineError] = useState<{ title: string; description: string } | null>(null);
  // #453: an existing gated minor is held on a blocking guardian flow AFTER the
  // login OTP (ownership proven) and BEFORE landing on home — never home-first.
  // Null until the post-verify u18 check decides the ward needs it.
  const [guardianGate, setGuardianGate] = useState<{ initialStep: 'dob' | 'guardian' } | null>(null);

  const state = location.state as AuthState | null;
  const identifierLabel = state?.email ?? state?.phoneNumber;

  useEffect(() => {
    if (!identifierLabel) navigate('/auth/login');
  }, [identifierLabel, navigate]);

  // Final step once verification (and, for a gated minor, the guardian flow)
  // has settled: toast + land. #376: if the user has no *completed* profile
  // (none, or all still draft), route them straight to the profile create/edit
  // page — instead of home, where they wouldn't know what to do. That decision
  // (including its precedence over `redirectTo` and its fail-open behaviour)
  // now lives in `resolvePostLoginLanding`, shared with the OIDC callback so
  // the two login paths can't drift (#558).
  const finishSignIn = async () => {
    if (!state) return;
    toast.success(state.userExists ? t('auth.toast_welcome_back') : t('auth.toast_account_created'), {
      description: state.userExists
        ? t('auth.toast_welcome_back_desc')
        : t('auth.toast_account_created_desc'),
    });
    const landing = await resolvePostLoginLanding(themeId, state.redirectTo ?? '/');
    navigate(landing, { replace: true });
  };

  const handleOtpComplete = async (otp: string) => {
    if (!state || !identifierLabel) return;
    setIsLoading(true);
    setInlineError(null);
    try {
      await verifyOtp(getAuthIdentifier(state), otp, state.userExists ? undefined : state.name);

      // Per-domain UI: block a user who already holds a profile in a domain
      // this deployment does not serve (they must use that domain's portal).
      const scope = getServedScope();
      if (scope) {
        const held = await resolveHeldDomains(scope.network);
        const gate = evaluateDomainGate(held, scope.domains);
        if (!gate.allow) {
          await signOut();
          navigate('/auth/login', { replace: true, state: { wrongPortalDomain: gate.heldDomain } });
          return;
        }
      }

      // Persist consent that was accepted pre-OTP on the login page.
      // The write is best-effort: on failure we toast but still navigate
      // (the user is authenticated; they will be re-prompted next login).
      if (state.pendingConsent) {
        try {
          await acceptConsent(state.pendingConsent);
        } catch {
          toast.error(t('auth.toast_consent_persist_error', 'Could not save your consent. You may be asked again next time.'));
        }
      }

      // U18 age/guardian was collected in the auth flow BEFORE this OTP (signup
      // gate, or the existing-user pre-check). Persist it now that the session
      // exists. Best-effort like the consent-accept write above — never block
      // sign-in on it.
      if (state.signupExtras) {
        const { domain, age } = state.signupExtras;
        // New signup: hand the chosen domain off to profile-form-page (one-shot)
        // AND persist it on the user so profile creation is restricted to it.
        if (!state.userExists) {
          setStoredSignupDomain(themeId, domain);
          try {
            await setUserDomains([domain]);
          } catch {
            // Best-effort — profile-form falls back to held items if unset.
          }
        }
        // Age only exists for guardian-gated flows; persist it for the now-auth
        // user (idempotent for a signup minor already materialized on create).
        if (age !== undefined) {
          try {
            await submitU18Dob({ network: themeId, age });
          } catch {
            toast.error(t('auth.toast_consent_persist_error', 'Could not save your consent. You may be asked again next time.'));
          }
        }
      }

      // Existing gated minor (#453): now that the login OTP has proven number
      // ownership, run the guardian flow HERE — before home — instead of
      // deferring it to the home page. New signups already cleared the pre-auth
      // guardian flow (their signupExtras path), so this only affects returning
      // users. Best-effort: if the status lookup fails, fall through to home;
      // the home-page guardian gate remains as a backstop, and the API gate is
      // the real fail-closed control regardless.
      // An existing minor picked their year of birth pre-OTP; it's persisted
      // just above (signupExtras → submitU18Dob), so u18/status now reports
      // isMinor. Run the AUTHENTICATED guardian flow here — before home — since
      // the guardian APIs need this session. Starts at the guardian step (DOB
      // already known). onComplete/onNotMinor calls finishSignIn.
      if (state.userExists) {
        try {
          const u18 = await getU18Status(themeId);
          if (u18.isMinor && !u18.guardianVerified) {
            setGuardianGate({ initialStep: u18.hasBirthData ? 'guardian' : 'dob' });
            return;
          }
        } catch {
          // fall through to finishSignIn
        }
      }

      await finishSignIn();
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
      restartCountdown();
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

  // Blocking guardian gate for an existing minor (#453) — replaces the OTP form
  // inside the same AuthShell (mirrors the pre-auth SignupGuardianFlow), so the
  // ward never sees home until the guardian is verified. `onNotMinor` (DOB
  // resolved adult) and `onComplete` (guardian verified) both proceed home.
  if (guardianGate) {
    return (
      <AuthShell>
        <U18GuardianFlow
          inline
          network={themeId}
          brand={brand === 'standard' ? null : brand}
          purpose={{ kind: 'login' }}
          initialStep={guardianGate.initialStep}
          onComplete={finishSignIn}
          onNotMinor={finishSignIn}
          onLogout={() => {
            void signOut();
            navigate('/auth/login', { replace: true });
          }}
        />
      </AuthShell>
    );
  }

  return (
    <>
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
    </>
  );
}
