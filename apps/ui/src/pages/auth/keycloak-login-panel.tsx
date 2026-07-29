import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, LockKeyhole, OctagonX, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/auth-context';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import {
  consentStatusIdentifier,
  isValidPhoneNumber,
  signupWithKeycloak,
  type AuthIdentifier,
} from '@/lib/auth-api';
import { fetchConsentConfigs, getConsentStatusByIdentifier } from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import { setPendingConsent } from '@/lib/pending-consent';
import { fetchNetworkConfig } from '@/lib/network-api';
import { isMinorFromDate } from '@/lib/guardian-consent';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';
import { getServedScope } from '@/lib/served-binding';
import type { DotNetworkDomain } from '@/engine/types';
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';

/**
 * The login screen for deployments where the API reports `authProvider:
 * 'keycloak'`.
 *
 * Two states. First a **chooser** — existing user vs. new — because the two go to
 * very different places, and the OTP screen's "type an identifier and we'll work
 * it out" trick isn't available here: identity lookup lives inside Keycloak now.
 *
 * Signing in is a pure hand-off: identifier entry, OTP delivery, verification and
 * the consent gates all live in Keycloak's flow (the custom OTP authenticator).
 *
 * Signing up **cannot** be a hand-off. The OTP SPI is login-only — it fails with
 * `user_not_found` for an unknown identifier and cannot create users — and
 * Keycloak's built-in registration form is password-based, which breaks the
 * passwordless model. So signals creates the identity via
 * `POST /api/v1/auth/signup`, parks the signals-only fields (domain, DOB) against
 * the identifier, and then sends the person through the normal login. Nothing
 * exists in signals until that login succeeds; provisioning applies the parked
 * fields at that point.
 */
export function KeycloakLoginPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { startKeycloakLogin } = useAuth();
  const { config } = useAuthConfig();
  const { themeId, brand } = useNetworkTheme();

  const [mode, setMode] = useState<'choose' | 'signup'>('choose');
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [domain, setDomain] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [networkDomains, setNetworkDomains] = useState<DotNetworkDomain[]>([]);
  /**
   * Set only for a brand-new MINOR signing up into a guardian-gated domain.
   * Renders the pre-auth guardian capture BEFORE the account is created, exactly
   * as the OTP flow does (U18 option A): `startSignupGuardian` parks the capture
   * against the signup identifier, and provisioning's `materializeSignupGuardian`
   * writes it onto the user row at first login.
   *
   * A minor does NOT go through the ordinary terms/privacy gate — the guardian
   * flow records their consent guardian-sourced instead.
   */
  const [guardianGate, setGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    dateOfBirth: Date;
  } | null>(null);
  // Set when terms/privacy need accepting before the account is created —
  // mirrors the OTP screen's gate (`runConsentThenOtp` in login-page.tsx).
  const [consentGate, setConsentGate] = useState<{
    config: ConsentConfigDocument;
    pendingConsent: ConsentAcceptBody;
    identifier: AuthIdentifier;
  } | null>(null);

  // Same contract as the OTP login: RequireAuth sends the intended path here
  // as ?redirect=, and it must survive the round-trip through Keycloak.
  const redirectTo = searchParams.get('redirect') ?? '/';

  const channels = config?.loginChannels ?? ['phone', 'email'];
  const canSignup = config?.selfSignupAllowed === true;
  // Phone first when both are enabled, matching the OTP screen's default.
  const signupChannel = channels.includes('phone') ? 'phone' : 'email';

  // Domain options come from the served network's own schema — not user input —
  // so a signup can only ever name a domain the network actually defines. The
  // API validates against served domains again; this is just the picker.
  useEffect(() => {
    if (mode !== 'signup') return;
    fetchNetworkConfig(themeId)
      .then((cfg) => setNetworkDomains(cfg.domains ?? []))
      .catch(() => setNetworkDomains([]));
  }, [mode, themeId]);

  const servedScope = getServedScope();
  const domainOptions = servedScope
    ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
    : networkDomains;

  const handleSignIn = async () => {
    setIsRedirecting(true);
    setError(null);
    try {
      await startKeycloakLogin(redirectTo);
      // On success the browser navigates to Keycloak and never gets here.
    } catch (err) {
      setIsRedirecting(false);
      setError(err instanceof Error ? err.message : t('auth.oidc_error_desc'));
    }
  };

  const handleSignup = async () => {
    setError(null);

    if (!name.trim()) {
      setError(t('auth.signup_name_required'));
      return;
    }
    if (signupChannel === 'phone' && !isValidPhoneNumber(phoneNumber)) {
      toast.error(t('auth.toast_invalid_phone'), {
        description: t('auth.toast_invalid_phone_desc'),
      });
      return;
    }
    if (signupChannel === 'email' && !email.trim()) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return;
    }

    /**
     * Normalise ONCE, here, and use this everywhere downstream.
     *
     * The pre-auth guardian capture is keyed on a hash of the identifier and the
     * server only trims it — it does not convert to E.164. Handing the guardian
     * flow the raw national number while the Keycloak token later carries the
     * E.164 form means `materializeSignupGuardian` finds no match at first login
     * and silently no-ops: the user completes the guardian OTP, the account is
     * created, and the guardian record is dropped. `login-page` avoids this the
     * same way (`toE164` before building its identifier).
     */
    const identifier: AuthIdentifier =
      signupChannel === 'phone' ? { phoneNumber: toE164(phoneNumber) } : { email: email.trim() };

    // A minor in a guardian-gated domain must have a guardian captured and
    // OTP-verified before the account exists — same ordering as the OTP flow.
    // Mirrors the server check in services/minor.ts; the server re-checks and
    // rejects an adult with NOT_A_MINOR.
    const domainIsGated =
      networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false;
    if (domain && domainIsGated && dateOfBirth) {
      const dob = new Date(dateOfBirth);
      if (!Number.isNaN(dob.getTime()) && isMinorFromDate(dob)) {
        setGuardianGate({ identifier, domain, dateOfBirth: dob });
        return;
      }
    }

    setIsSigningUp(true);
    // Terms/privacy must be accepted BEFORE the account is created, matching the
    // OTP flow's ordering. If the gate opens, `handleConsentAccept` resumes here.
    const gated = await openConsentGateIfNeeded(identifier);
    if (gated) {
      setIsSigningUp(false);
      return;
    }
    await createAccountAndSignIn(identifier);
  };

  /**
   * Consent pre-check, mirroring `runConsentThenOtp` in login-page.tsx.
   *
   * Returns true when the modal is now showing and signup should pause. Fails
   * OPEN on error, exactly as the OTP flow does — a consent-service blip must not
   * block registration; the user is re-prompted on their next login.
   */
  const openConsentGateIfNeeded = async (identifier: AuthIdentifier): Promise<boolean> => {
    try {
      // Normalize the phone to the canonical E.164 form the API stores, or the
      // exact-match lookup misses and the gate re-prompts every time.
      const identifierParam = consentStatusIdentifier(identifier);

      const [consentStatus, configEntries] = await Promise.all([
        getConsentStatusByIdentifier({ network: themeId, ...identifierParam }),
        fetchConsentConfigs(themeId),
      ]);

      const networkDefault = configEntries.find((e) => e.brand === null);
      if (!networkDefault) return false;

      const brandEntry =
        brand && brand !== 'standard' ? configEntries.find((e) => e.brand === brand) : undefined;
      const mergedConfig = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

      const needed = (['terms', 'privacy'] as const).filter(
        (c) => !consentStatus.statuses[c].includes(mergedConfig.documents[c].current_version),
      );
      if (needed.length === 0) return false;

      setConsentGate({
        config: mergedConfig,
        identifier,
        pendingConsent: {
          network: themeId,
          brand: brand !== 'standard' ? brand : null,
          source: 'signup',
          items: needed.map((c) => ({
            category: c,
            version: mergedConfig.documents[c].current_version,
          })),
        },
      });
      return true;
    } catch {
      // Fail open — same posture as the OTP flow's pre-check.
      return false;
    }
  };

  /**
   * Accepted in the modal. The acceptance can't be written yet — the accept
   * endpoint is authenticated — so park it for the callback page to flush once
   * the session exists, then carry on creating the account.
   */
  const handleConsentAccept = async () => {
    if (!consentGate) return;
    const { pendingConsent, identifier } = consentGate;
    setPendingConsent(pendingConsent);
    setConsentGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier);
  };

  /**
   * Guardian captured and verified. Create the account straight away — the
   * guardian flow has already recorded terms/privacy guardian-sourced, so the
   * ordinary consent gate must not also run.
   */
  const handleGuardianComplete = async () => {
    if (!guardianGate) return;
    const { identifier } = guardianGate;
    setGuardianGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier);
  };

  const createAccountAndSignIn = async (identifier: AuthIdentifier) => {
    try {
      const result = await signupWithKeycloak({
        name: name.trim(),
        ...identifier,
        ...(domain ? { domain } : {}),
        ...(dateOfBirth ? { dateOfBirth } : {}),
      });

      // Either way the next step is the same — sign in. An identifier that is
      // already taken isn't something the user needs to act on differently.
      toast.success(
        result.alreadyRegistered
          ? t('auth.signup_existing_title')
          : t('auth.signup_created_title'),
        {
          description: result.alreadyRegistered
            ? t('auth.signup_existing_desc')
            : t('auth.signup_created_desc'),
        }
      );
      await handleSignIn();
    } catch (err) {
      const apiMessage = (err as { response?: { data?: { message?: unknown } } } | null)
        ?.response?.data?.message;
      setError(
        typeof apiMessage === 'string' && apiMessage.trim() !== ''
          ? apiMessage
          : t('auth.oidc_error_desc')
      );
    } finally {
      setIsSigningUp(false);
    }
  };

  const busy = isRedirecting || isSigningUp;

  return (
    <>
      {consentGate && (
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          onAccept={() => {
            void handleConsentAccept();
          }}
        />
      )}
      <AuthShell>
      <button
        type="button"
        onClick={() => (mode === 'signup' ? setMode('choose') : navigate('/'))}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('auth.back')}
      </button>

      <div className="mb-6">
        <h2 className="text-3xl font-bold text-foreground">
          {mode === 'signup'
            ? t('auth.heading_create_account')
            : t('auth.heading_welcome_back')}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {mode === 'signup' ? t('auth.signup_sub') : t('auth.choose_sub')}
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <OctagonX className="size-4" />
          <AlertTitle>{t('auth.oidc_error_title')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {guardianGate ? (
        <SignupGuardianFlow
          network={themeId}
          domain={guardianGate.domain}
          brand={brand !== 'standard' ? brand : null}
          identifier={
            (guardianGate.identifier.email
              ? { email: guardianGate.identifier.email }
              : { phoneNumber: guardianGate.identifier.phoneNumber }) as SignupIdentifier
          }
          dateOfBirth={guardianGate.dateOfBirth}
          onComplete={() => {
            void handleGuardianComplete();
          }}
        />
      ) : mode === 'choose' ? (
        <div className="space-y-3">
          <ChoiceCard
            icon={<LockKeyhole className="size-5" />}
            title={t('auth.choose_existing_title')}
            description={t('auth.choose_existing_desc')}
            emphasised
            disabled={busy}
            busy={isRedirecting}
            onClick={() => {
              void handleSignIn();
            }}
          />

          {canSignup && (
            <ChoiceCard
              icon={<UserPlus className="size-5" />}
              title={t('auth.choose_new_title')}
              description={t('auth.choose_new_desc')}
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode('signup');
              }}
            />
          )}

          {!canSignup && (
            <p className="pt-1 text-sm text-muted-foreground">
              {t('auth.signup_disabled_message')}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signup-name">{t('auth.label_name')}</Label>
            <Input
              id="signup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('auth.placeholder_name')}
              autoComplete="name"
            />
          </div>

          {signupChannel === 'phone' ? (
            <div className="space-y-1.5">
              <Label htmlFor="signup-phone">{t('auth.label_mobile')}</Label>
              <PhoneInput id="signup-phone" value={phoneNumber} onChange={setPhoneNumber} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="signup-email">{t('auth.label_email')}</Label>
              <Input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('auth.placeholder_email')}
                autoComplete="email"
              />
            </div>
          )}

          {domainOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t('auth.label_domain')}</Label>
              {/* Segmented toggle, matching the OTP signup form's domain picker. */}
              <div className="flex flex-wrap gap-1 rounded-full border border-border bg-muted p-1 text-sm">
                {domainOptions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDomain(d.id)}
                    disabled={busy}
                    className={[
                      'flex-1 rounded-full py-1.5 px-3 font-medium transition-colors capitalize whitespace-nowrap',
                      domain === d.id
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    ].join(' ')}
                  >
                    {d.id.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="signup-dob">{t('auth.label_dob')}</Label>
            <Input
              id="signup-dob"
              type="date"
              value={dateOfBirth}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('auth.signup_dob_hint')}</p>
          </div>

          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              void handleSignup();
            }}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isSigningUp ? t('auth.signup_submitting') : t('auth.oidc_redirecting')}
              </>
            ) : (
              t('auth.cta_create_account')
            )}
          </Button>
        </div>
      )}
      </AuthShell>
    </>
  );
}

/**
 * One of the two entry choices. A button rather than a link because both do work
 * (one redirects to Keycloak, one swaps the panel) — nothing here is navigation.
 */
function ChoiceCard({
  icon,
  title,
  description,
  emphasised = false,
  disabled,
  busy = false,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  emphasised?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-4 rounded-xl border px-4 py-4 text-left transition-colors disabled:opacity-60 ${
        emphasised
          ? 'border-primary/60 hover:border-primary'
          : 'border-border hover:border-foreground/30'
      }`}
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
          emphasised ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
        }`}
      >
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
      </span>

      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
          emphasised ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ArrowRight className="size-4" />
        )}
      </span>
    </button>
  );
}
