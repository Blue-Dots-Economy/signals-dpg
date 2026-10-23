import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/layout/auth-shell';
import { formatDomainLabel } from '@/lib/domain-icons';
import {
  checkUser,
  consentStatusIdentifier,
  isValidPhoneNumber,
  requestOtp,
  u18Precheck,
  type AuthConfigResponse,
  type AuthIdentifier,
  type LoginChannel,
} from '@/lib/auth-api';
import {
  fetchConsentConfigs,
  getConsentStatusByIdentifier,
} from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import { useNetworkTheme } from '@/theme/theme-provider';
import type { ConsentAcceptBody } from '@dpg/schemas';
import { buildOutstandingConsent, type OutstandingConsent } from '@/lib/consent-gate';
import { toast } from 'sonner';
import { fetchNetworkConfig } from '@/lib/network-api';
import type { DotNetworkDomain } from '@/engine/types';
import { getServedScope } from '@/lib/served-binding';
import type { SignupExtras } from '@/lib/signup-domain';
import { SignupDobStep } from '@/components/consent/u18/signup-dob-step';
import { isMinorFromAge } from '@/lib/guardian-consent';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { KeycloakLoginPanel } from './keycloak-login-panel';
import { SessionExpiredNotice } from './session-expired-notice';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';

type AuthMode = 'phone' | 'email';

type PendingConsent = ConsentAcceptBody;

/** The gate state is the shared shape — see `lib/consent-gate`. */
type ConsentGateState = OutstandingConsent;

function domainLabel(domain: DotNetworkDomain): string {
  return formatDomainLabel(domain.id, [domain]);
}


/**
 * Explains a sign-in that failed before a session existed (cancelled at
 * Keycloak, an expired flow, or a refused code exchange). The API can only
 * signal it as `?auth_error=1` on the redirect. Lives on the wrapper so it runs
 * whichever panel mounts.
 */
function useFailedSignInNotice(): void {
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  useEffect(() => {
    if (searchParams.get('auth_error') !== '1') return;
    toast.error(t('auth.oidc_error_title', 'Sign-in could not be completed'), {
      // Stable id so StrictMode's double-invoke shows one toast, not two.
      id: 'oidc-auth-error',
      description: t(
        'auth.oidc_error_cancelled',
        'The sign-in was cancelled or timed out. Please try again.',
      ),
    });
    // Scrub the param so a refresh does not re-announce a stale failure.
    const url = new URL(window.location.href);
    url.searchParams.delete('auth_error');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, [searchParams, t]);
}

/**
 * Route entry for /auth/login. The choice comes from `GET /api/v1/auth/config`
 * (see lib/keycloak-config.ts), made before either panel's hooks run. The API
 * only reports `keycloak`; the OTP screen is the legacy better-auth login,
 * reached only through the `VITE_AUTH_PROVIDER=betterauth` override or a
 * missing Keycloak config, and its `/api/auth/*` endpoints no longer exist.
 */
export function LoginPage() {
  const { isKeycloakLogin, isLoading } = useAuthConfig();
  useFailedSignInNotice();

  if (isLoading) {
    return (
      <AuthShell>
        <div className="mx-auto flex max-w-md justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  return isKeycloakLogin ? <KeycloakLoginPanel /> : <OtpLoginPage />;
}

function OtpLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { t } = useTranslation();
  const { themeId, brand } = useNetworkTheme();

  useEffect(() => {
    const wrongPortalDomain = (location.state as { wrongPortalDomain?: string } | null)?.wrongPortalDomain;
    if (wrongPortalDomain) {
      // Stable id de-dupes the toast across StrictMode's double-invoke.
      toast.error(t('auth.wrong_portal', { domain: wrongPortalDomain }), {
        id: 'wrong-portal-block',
      });
      // Clear the state so the toast doesn't re-fire on back/refresh.
      window.history.replaceState({}, '');
    }
  }, [location.state, t]);

  const [mode, setMode] = useState<AuthMode>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [userExists, setUserExists] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [consentGate, setConsentGate] = useState<ConsentGateState | null>(null);
  // Shared with the wrapper via React Query. The fail-safe default (gated,
  // both channels) keeps the API authoritative if the request fails.
  const { config: fetchedAuthCfg } = useAuthConfig();
  const authCfg: AuthConfigResponse | null =
    fetchedAuthCfg ?? { selfSignupAllowed: false, loginChannels: ['phone', 'email'] };
  const [signupBlocked, setSignupBlocked] = useState(false);
  const [networkDomains, setNetworkDomains] = useState<DotNetworkDomain[]>([]);
  // The identifier captured at submission, so the consent accept and the OTP
  // request use the same normalized values.
  const [pendingIdentifier, setPendingIdentifier] = useState<AuthIdentifier | null>(null);
  const [pendingUserExists, setPendingUserExists] = useState<boolean>(false);
  const [pendingName, setPendingName] = useState<string>('');
  const [pendingSignupExtras, setPendingSignupExtras] = useState<SignupExtras | null>(null);
  // Set only for a new minor signup in a guardian-gated domain: renders the
  // pre-auth guardian flow and defers the ward's own OTP until the guardian is
  // verified.
  const [signupGuardianGate, setSignupGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    age: number;
    resolvedName: string;
    resolvedSignupExtras: SignupExtras;
    /** True for an existing user backfilling age before login. */
    exists: boolean;
  } | null>(null);
  // Set for a guardian-gated domain to render the DOB step: after the
  // name/domain form for a new signup, or after the phone check (before the
  // login OTP) for an existing user missing DOB.
  const [signupDobGate, setSignupDobGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    resolvedName: string;
    exists: boolean;
  } | null>(null);
  const redirectTo = searchParams.get('redirect') ?? '/';
  const servedScope = useMemo(() => getServedScope(), []);

  // Domain options come from the served network's schema, so a signup can only
  // submit a domain the network defines.
  useEffect(() => {
    fetchNetworkConfig(themeId)
      .then((cfg) => setNetworkDomains(cfg.domains ?? []))
      .catch(() => setNetworkDomains([]));
  }, [themeId]);

  // Restrict to the served domains when this deployment is bound to a subset.
  const domainOptions = servedScope
    ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
    : networkDomains;

  // Exactly one served domain: auto-select it (so the signup carries a domain
  // and the DOB/guardian gating runs) and hide the picker.
  useEffect(() => {
    if (domainOptions.length === 1 && !domain) {
      setDomain(domainOptions[0].id);
    }
  }, [domainOptions, domain]);

  const channels: LoginChannel[] = authCfg?.loginChannels ?? ['phone', 'email'];
  const onlyEmail = channels.length === 1 && channels[0] === 'email';
  const onlyPhone = channels.length === 1 && channels[0] === 'phone';

  useEffect(() => {
    if (authCfg && !authCfg.loginChannels.includes(mode)) {
      setMode(authCfg.loginChannels[0]);
    }
  }, [authCfg, mode]);

  // phoneNumber holds the national part; the wire value is the full E.164.
  const fullPhone = toE164(phoneNumber);
  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber: fullPhone };
  const contactValue = mode === 'email' ? email : phoneNumber;
  // Phone mode needs the full 10-digit national number before "Continue".
  const contactComplete = mode === 'email' ? email.trim().length > 0 : phoneNumber.length === 10;
  const contactLabel = mode === 'email'
    ? t('auth.contact_label_email')
    : t('auth.contact_label_phone');

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    setUserExists(null);
    setSignupBlocked(false);
  };

  const proceedToOtp = async (
    resolvedIdentifier: AuthIdentifier,
    resolvedUserExists: boolean,
    resolvedName: string,
    resolvedSignupExtras: SignupExtras | null,
    pendingConsent?: PendingConsent,
  ) => {
    await requestOtp(resolvedIdentifier);
    navigate('/auth/otp', {
      state: {
        ...resolvedIdentifier,
        userExists: resolvedUserExists,
        name: resolvedName,
        redirectTo,
        pendingConsent: pendingConsent ?? null,
        // A new signup's domain + age, or an existing minor's pre-OTP age.
        // otp-page persists it.
        signupExtras: resolvedSignupExtras,
      },
    });
  };

  const handleConsentAccept = async () => {
    if (!consentGate || !pendingIdentifier) return;
    // Close the modal first so a double-click cannot re-enter.
    const gate = consentGate;
    const ident = pendingIdentifier;
    const userEx = pendingUserExists;
    const uname = pendingName;
    const extras = pendingSignupExtras;
    setConsentGate(null);
    try {
      await proceedToOtp(ident, userEx, uname, extras, gate.pendingConsent);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    }
  };

  // Evaluate consent, then send the OTP (or hold for the consent modal).
  // Fails open: on a pre-check error the OTP is sent and the user is
  // re-prompted on their next login. Minors never reach this; the guardian
  // flow records their consent.
  const runConsentThenOtp = async (
    ident: AuthIdentifier,
    exists: boolean,
    resolvedName: string,
    resolvedSignupExtras: SignupExtras | null,
  ) => {
    try {
      // Canonical E.164, or the exact-match lookup misses a returning user.
      const identifierParam = consentStatusIdentifier(ident);

      const [consentStatus, configEntries] = await Promise.all([
        getConsentStatusByIdentifier({ network: themeId, ...identifierParam }),
        fetchConsentConfigs(themeId),
      ]);

      const networkDefault = configEntries.find((e) => e.brand === null);
      if (networkDefault) {
        const brandEntry = brand && brand !== 'standard'
          ? configEntries.find((e) => e.brand === brand)
          : undefined;
        const mergedConfig = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

        const outstanding = buildOutstandingConsent({
          config: mergedConfig,
          network: themeId,
          brand,
          source: exists ? 'login' : 'signup',
          accepted: consentStatus.statuses,
          // No variant: `status-by-identifier` is unauthenticated and does not
          // report one, so this is always the adult set. A minor gets the U18
          // documents post-auth from the guardian flow.
        });

        if (outstanding) {
          setPendingIdentifier(ident);
          setPendingUserExists(exists);
          setPendingName(resolvedName);
          setPendingSignupExtras(resolvedSignupExtras);
          setConsentGate(outstanding);
          // Wait for accept before sending the OTP.
          setIsLoading(false);
          return;
        }
      }
    } catch {
      // Fail open.
    }

    await proceedToOtp(ident, exists, resolvedName, resolvedSignupExtras);
  };

  // Birth-year step: a minor goes to the guardian flow, an adult to consent +
  // OTP. Age rides in signupExtras for otp-page to persist.
  const handleSignupDob = async (age: number) => {
    const gate = signupDobGate;
    if (!gate) return;
    const extras: SignupExtras = { domain: gate.domain, age };
    setSignupDobGate(null);

    // A minor never sees the adult terms/privacy consent.
    if (isMinorFromAge(age)) {
      if (!gate.exists) {
        // New minor: the guardian flow is the next screen.
        toast.info(t('auth.minor_toast_title', "You're under 18"), {
          description: t(
            'auth.minor_toast_desc',
            'A guardian needs to confirm your account before you can continue.',
          ),
        });
        setSignupGuardianGate({
          identifier: gate.identifier,
          domain: gate.domain,
          age,
          resolvedName: gate.resolvedName,
          resolvedSignupExtras: extras,
          exists: gate.exists,
        });
        return;
      }
      // Existing minor: the guardian APIs are session-scoped, so the guardian
      // step runs after the login OTP (in otp-page). Skip the adult consent
      // and send the OTP.
      toast.info(t('auth.minor_toast_title', "You're under 18"), {
        description: t(
          'auth.minor_verify_then_guardian_desc',
          'First verify your number, then a guardian will confirm your account.',
        ),
      });
      setIsLoading(true);
      try {
        await proceedToOtp(gate.identifier, gate.exists, gate.resolvedName, extras);
      } catch {
        toast.error(t('auth.toast_send_code_error'), {
          description: t('auth.toast_send_code_error_desc'),
        });
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setIsLoading(true);
    try {
      await runConsentThenOtp(gate.identifier, gate.exists, gate.resolvedName, extras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Guards split out of handleSubmit for complexity (Sonar S3776).
  // handleSubmit's `finally` owns `setIsLoading(false)`.

  /** Toasts and returns false when the number/email is malformed. */
  const validateContact = (): boolean => {
    if (mode === 'phone' && !isValidPhoneNumber(fullPhone)) {
      toast.error(t('auth.toast_invalid_phone'), {
        description: t('auth.toast_invalid_phone_desc'),
      });
      return false;
    }
    if (mode === 'email' && !/^[^\s@]+@[^\s.@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return false;
    }
    return true;
  };

  /** Signup-only guards (self-signup gate, name, domain). True = halt. */
  const signupPreflightHalts = (exists: boolean): boolean => {
    if (!exists && authCfg && !authCfg.selfSignupAllowed) {
      toast.error(t('auth.toast_signup_disabled'), {
        description: t('auth.toast_signup_disabled_desc'),
      });
      setSignupBlocked(true);
      return true;
    }
    if (!exists && !name.trim()) {
      toast.info(t('auth.toast_one_more_step'), {
        description: t('auth.toast_one_more_step_desc', { contactLabel }),
      });
      return true;
    }
    if (!exists && !domain) {
      toast.error(
        domainOptions.length === 0
          ? t('auth.signup_options_unavailable')
          : t('auth.select_domain_required'),
      );
      return true;
    }
    return false;
  };

  /**
   * Existing-user U18 pre-check: opens the DOB step and returns true when a
   * year of birth is required. Fails open; the post-login gate still catches a
   * minor.
   */
  const resolveExistingDobGate = async (): Promise<boolean> => {
    try {
      const pre = await u18Precheck(themeId, identifier);
      if (pre.requiresDob) {
        setSignupDobGate({ identifier, domain: '', resolvedName: '', exists: true });
        return true;
      }
    } catch {
    }
    return false;
  };

  /**
   * Whether a new signup's domain goes live without `consent_required`, in
   * which case the terms/privacy pre-check is skipped. Absent config requires
   * consent.
   */
  const domainSkipsConsent = (): boolean => {
    const domGates = networkDomains.find((d) => d.id === domain)?.go_live_required;
    return domGates ? !domGates.includes('consent_required') : false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

    // The OTP send fails silently on a malformed number, so check here.
    if (!validateContact()) return;

    setIsLoading(true);
    try {
      const response = await checkUser(identifier);
      const exists = response.userExists;
      setUserExists(exists);
      setSignupBlocked(false);

      // DOB is a separate step for guardian-gated domains (below).
      if (signupPreflightHalts(exists)) return;

      const resolvedName = exists ? '' : name;

      // A new signup in a guardian-gated domain collects DOB in a separate
      // step. The server stays authoritative on minor + gated + served.
      const gatedDomain =
        !exists && (networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false);
      if (gatedDomain) {
        setSignupDobGate({ identifier, domain, resolvedName, exists: false });
        setIsLoading(false);
        return;
      }

      // Existing user missing DOB on a gated domain: collect the year before
      // the OTP. A minor then logs in first, because the guardian APIs are
      // session-scoped and must not be public for an existing account.
      if (exists && (await resolveExistingDobGate())) return;

      const resolvedSignupExtras: SignupExtras | null = exists ? null : { domain };

      // A new signup on a domain without `consent_required` skips the consent
      // pre-check. Returning users keep it.
      if (!exists && domainSkipsConsent()) {
        await proceedToOtp(identifier, exists, resolvedName, resolvedSignupExtras);
        return;
      }

      await runConsentThenOtp(identifier, exists, resolvedName, resolvedSignupExtras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Hide the signup form while the DOB step or guardian flow is active.
  const showSignupForm = !signupDobGate && !signupGuardianGate;

  // Guardian verified: send the ward's own OTP. No pendingConsent; the minor's
  // terms/privacy are recorded guardian-sourced at account creation.
  const handleGuardianComplete = () => {
    const gate = signupGuardianGate;
    if (!gate) return;
    setSignupGuardianGate(null);
    // Explain the hand-off to the ward's own OTP.
    toast.success(t('auth.guardian_confirmed_title', 'Guardian confirmed'), {
      description: t(
        'auth.guardian_confirmed_desc',
        "Now enter the code we're sending to your own {{contactLabel}} to finish creating your account.",
        { contactLabel },
      ),
    });
    void proceedToOtp(gate.identifier, gate.exists, gate.resolvedName, gate.resolvedSignupExtras).catch(() => {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    });
  };

  return (
    <>
      {consentGate && (
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          variant={consentGate.variant}
          onAccept={() => { void handleConsentAccept(); }}
        />
      )}
      <AuthShell>
        {signupDobGate ? (
          <SignupDobStep existing={signupDobGate.exists} onSubmit={(age) => { void handleSignupDob(age); }} />
        ) : signupGuardianGate ? (
          <SignupGuardianFlow
            network={themeId}
            domain={signupGuardianGate.domain}
            brand={brand !== 'standard' ? brand : null}
            identifier={
              (signupGuardianGate.identifier.email
                ? { email: signupGuardianGate.identifier.email }
                : { phoneNumber: signupGuardianGate.identifier.phoneNumber }) as SignupIdentifier
            }
            age={signupGuardianGate.age}
            onComplete={handleGuardianComplete}
            onBack={() => {
              // Back to the birth-year step.
              const g = signupGuardianGate;
              if (!g) return;
              setSignupGuardianGate(null);
              setSignupDobGate({
                identifier: g.identifier,
                domain: g.domain,
                resolvedName: g.resolvedName,
                exists: g.exists,
              });
            }}
          />
        ) : !showSignupForm ? null : (
        <>
        {/* Back link */}
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('auth.back')}
        </button>

        {/* Shared with the Keycloak panel. */}
        <SessionExpiredNotice />

        {/* Heading */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground">
            {userExists === null || signupBlocked
              ? t('auth.heading_sign_in')
              : userExists
                ? t('auth.heading_welcome_back')
                : t('auth.heading_create_account')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {userExists === null || signupBlocked
              ? t(onlyEmail ? 'auth.sub_initial_email' : onlyPhone ? 'auth.sub_initial_phone' : 'auth.sub_initial')
              : userExists
                ? t('auth.sub_existing', { contactLabel })
                : t('auth.sub_new', { contactLabel })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Phone / Email pill toggle — hidden entirely when only one channel is allowed */}
          {channels.length > 1 && (
            <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
              {channels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleModeChange(m)}
                  className={[
                    'flex-1 rounded-full py-1.5 font-medium transition-colors capitalize',
                    mode === m
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {/* Shown only for a new account with more than one served domain. */}
          {userExists === false && !signupBlocked && domainOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t('auth.label_domain', 'Your Domain')}
              </Label>
              {/* Outlined buttons: nothing is pre-selected, so each option
                  must read as a button on its own. */}
              <div className="flex flex-wrap gap-2 text-sm">
                {domainOptions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDomain(d.id)}
                    disabled={isLoading}
                    className={[
                      'flex-1 rounded-full border py-2 px-3 font-medium transition-colors capitalize whitespace-nowrap',
                      domain === d.id
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-border bg-background text-foreground hover:border-primary/60 hover:bg-muted',
                    ].join(' ')}
                  >
                    {domainLabel(d)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Contact input */}
          <div className="space-y-1.5">
            <Label htmlFor="contact" className="text-sm font-medium">
              {mode === 'email' ? t('auth.label_email') : t('auth.label_mobile')}
            </Label>
            {mode === 'phone' ? (
              <PhoneInput
                id="contact"
                value={phoneNumber}
                onChange={setPhoneNumber}
                disabled={isLoading}
                placeholder={t('auth.placeholder_phone', '10-digit mobile number')}
              />
            ) : (
              <Input
                id="contact"
                type="email"
                placeholder={t('auth.placeholder_email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                required
                className="h-11"
              />
            )}
          </div>

          {/* Name — only shown when creating account (and self-signup isn't gated) */}
          {userExists === false && !signupBlocked && (
            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-sm font-medium">
                {t('auth.label_name')}
              </Label>
              <Input
                id="name"
                type="text"
                placeholder={t('auth.placeholder_name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
                required
                className="h-11"
              />
            </div>
          )}

          {signupBlocked && (
            <p className="text-sm text-destructive">
              {t('auth.signup_disabled_message')}
            </p>
          )}

          {/* CTA */}
          <button
            type="submit"
            disabled={isLoading || !contactComplete}
            className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {/* A new signup has more steps before any OTP, so it reads
                "Continue". */}
            {userExists === true ? t('auth.cta_send_otp') : t('auth.cta_continue')}
          </button>
        </form>
        </>
        )}
      </AuthShell>
    </>
  );
}
