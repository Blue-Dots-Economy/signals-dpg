import { useEffect, useMemo, useState } from 'react';
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
import { useNetworkConfig } from '@/hooks/use-network-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import {
  consentStatusIdentifier,
  isValidPhoneNumber,
  signupWithKeycloak,
  type AuthIdentifier,
  type LoginChannel,
} from '@/lib/auth-api';
import { fetchConsentConfigs, getConsentStatusByIdentifier } from '@/lib/consent-api';
import { buildOutstandingConsent, type OutstandingConsent } from '@/lib/consent-gate';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import {
  clearPendingConsent,
  newConsentAttemptId,
  setPendingConsent,
} from '@/lib/pending-consent';
import { setPendingSignupExtras } from '@/lib/pending-signup-extras';
import { isMinorFromAge } from '@/lib/guardian-consent';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';
import { BirthYearSelect } from '@/components/consent/u18/birth-year-select';
import { getServedScope } from '@/lib/served-binding';
import type { DotNetworkDomain } from '@/engine/types';
import { formatDomainLabel } from '@/lib/domain-icons';
import { SessionExpiredNotice } from './session-expired-notice';

/**
 * `local@rest` with an inner dot in `rest`. Scanned with string operations
 * because the equivalent regex backtracks super-linearly.
 */
function hasEmailShape(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || value.includes('@', at + 1)) return false;
  const rest = value.slice(at + 1);
  const dot = rest.indexOf('.', 1);
  return dot !== -1 && dot < rest.length - 1;
}

/** Re-narrows to the discriminated pair the guardian flow's props take. */
function toSignupIdentifier(identifier: AuthIdentifier): SignupIdentifier {
  return (identifier.email
    ? { email: identifier.email }
    : { phoneNumber: identifier.phoneNumber }) as SignupIdentifier;
}

/**
 * The login screen for deployments where the API reports `authProvider:
 * 'keycloak'`. Starts with a chooser (existing user vs. new) because identity
 * lookup lives inside Keycloak.
 *
 * Sign-in is a pure hand-off: identifier entry, OTP delivery, verification and
 * the consent gates all live in Keycloak's flow (the custom OTP authenticator).
 *
 * Sign-up cannot be a hand-off: the OTP SPI is login-only (it cannot create
 * users) and Keycloak's registration form is password-based. So the API creates
 * the identity via `POST /api/v1/auth/signup`, parks the signals-only fields
 * (domain, age) against the identifier, and the person then signs in normally.
 * Provisioning applies the parked fields at that first login.
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
  /**
   * Age derived from the birth year the user picks; day and month are never
   * collected. Undefined until a year is chosen.
   */
  const [age, setAge] = useState<number | undefined>(undefined);
  /**
   * Set only for a new minor signing up into a guardian-gated domain. The
   * guardian is captured before the account exists, parked against the signup
   * identifier, and written onto the user row at first login
   * (`materializeSignupGuardian`). A minor skips the ordinary terms/privacy
   * gate; the guardian flow records their consent as guardian-sourced.
   */
  const [guardianGate, setGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    age: number;
  } | null>(null);
  // Set when terms/privacy need accepting before the account is created.
  const [consentGate, setConsentGate] = useState<
    (OutstandingConsent & { identifier: AuthIdentifier }) | null
  >(null);

  // RequireAuth passes the intended path as ?redirect=; it must survive the
  // round trip through Keycloak.
  const redirectTo = searchParams.get('redirect') ?? '/';

  const channels: LoginChannel[] = config?.loginChannels ?? ['phone', 'email'];
  const canSignup = config?.selfSignupAllowed === true;

  /**
   * Identifier channel for the new account. Phone is the default; a signup may
   * use either channel the instance allows.
   */
  const [signupChannel, setSignupChannel] = useState<LoginChannel>('phone');

  // The config arrives after first paint, so the default may be a channel this
  // instance does not run.
  useEffect(() => {
    if (config && !config.loginChannels.includes(signupChannel)) {
      setSignupChannel(config.loginChannels[0]);
    }
  }, [config, signupChannel]);

  /**
   * Domain options come from the served network's own schema, so a signup can
   * only name a domain the network defines (the API validates again). React
   * Query keeps the last good config across a failed refetch, so a blip cannot
   * empty the list `guardian_consent_required` is read from. Disabled outside
   * signup mode.
   */
  const {
    data: networkConfig,
    isLoading: domainsLoading,
    isError: domainsError,
    refetch: refetchNetworkConfig,
  } = useNetworkConfig(mode === 'signup' ? themeId : null);
  const networkDomains = useMemo(() => networkConfig?.domains ?? [], [networkConfig]);

  // Memoised so the auto-select effect below has a stable dependency.
  const servedScope = useMemo(() => getServedScope(), []);
  const domainOptions = useMemo(
    () =>
      servedScope
        ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
        : networkDomains,
    [servedScope, networkDomains],
  );

  // Exactly one served domain: auto-select it and hide the picker. This lets
  // `handleSignup` reach the gated-domain branch; that branch is enforced by a
  // separate guard there (a gated domain rejects a missing age).
  useEffect(() => {
    if (domainOptions.length === 1 && !domain) {
      setDomain(domainOptions[0].id);
    }
  }, [domainOptions, domain]);

  /**
   * Whether the chosen domain routes minors through the guardian flow; only
   * then is a birth year asked for. Resolves to false while the network config
   * is loading, which just hides the field. `handleSignup` re-reads the flag
   * from the resolved domain entry before deciding the U18 gate.
   */
  const selectedDomainIsGated =
    networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false;

  /**
   * The picker unmounts when the domain is not gated and `BirthYearSelect` owns
   * the year, so clear a stale age whenever the field is off screen; what is
   * submitted is always what is displayed.
   */
  useEffect(() => {
    if (!selectedDomainIsGated) setAge(undefined);
  }, [selectedDomainIsGated]);

  /**
   * Clears the busy flags when the page is restored from the bfcache (Back
   * after the Keycloak redirect), which would otherwise leave every choice
   * disabled. `pageshow` with `persisted: true` is the only signal for a
   * bfcache restore. Not reproducible under `vite dev`, whose HMR socket makes
   * the page ineligible for the bfcache.
   */
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setIsRedirecting(false);
      setIsSigningUp(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const handleSignIn = async (consentAttempt?: string) => {
    setIsRedirecting(true);
    setError(null);
    try {
      await startKeycloakLogin(redirectTo, consentAttempt);
      // On success the browser navigates to Keycloak and never gets here.
    } catch (err) {
      setIsRedirecting(false);
      setError(err instanceof Error ? err.message : t('auth.oidc_error_desc'));
    }
  };

  /**
   * The selected domain's entry in the loaded list, or null after telling the
   * user why. A miss must block rather than fall through: treating "not in the
   * list" as "not gated" would let a failed refetch switch off the U18 gate.
   */
  const resolveSelectedDomain = (): DotNetworkDomain | null => {
    // Mid-fetch: report "still loading" and let the in-flight request finish.
    if (domainsLoading) {
      toast.error(t('auth.signup_options_loading'));
      return null;
    }

    const meta = domain ? networkDomains.find((d) => d.id === domain) : undefined;
    if (meta) return meta;

    if (domainsError) {
      // Transient: retry so the next attempt can recover without a reload.
      refetchNetworkConfig();
      toast.error(t('auth.signup_options_unavailable'));
    } else if (domainOptions.length === 0) {
      // Loaded but nothing selectable is a config problem (no domains, or
      // VITE_SERVED_BINDINGS names an undefined one); retrying cannot fix it.
      toast.error(t('auth.signup_options_unavailable'));
    } else {
      toast.error(t('auth.select_domain_required'));
    }
    return null;
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
    // The API takes `z.email()`, so catch a malformed address here.
    if (signupChannel === 'email' && !hasEmailShape(email.trim())) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return;
    }
    // A signup must carry a domain: `domain` is optional on POST /auth/signup,
    // and without one the single-domain lock never binds and the U18 branch
    // below is skipped.
    const selectedDomainMeta = resolveSelectedDomain();
    if (!selectedDomainMeta) return;

    // Normalise once and use it everywhere: the pre-auth guardian capture is
    // keyed on a hash of the identifier and the server only trims it, so a
    // non-E.164 phone here would not match the Keycloak token at first login and
    // the guardian record would be silently dropped.
    const identifier: AuthIdentifier =
      signupChannel === 'phone' ? { phoneNumber: toE164(phoneNumber) } : { email: email.trim() };

    // Read from the resolved entry, not the render-time flag, which falls back
    // to `false` for an unknown domain.
    const domainIsGated = selectedDomainMeta.guardian_consent_required === true;

    // On a gated domain the age must be known before the account exists; the
    // field is optional in the form, so an unpicked year would sign a minor up
    // as an adult.
    if (domainIsGated && age === undefined) {
      toast.error(t('auth.signup_dob_required'));
      return;
    }

    // A minor in a gated domain needs a guardian captured and OTP-verified
    // before the account exists. The server re-checks (`services/minor.ts`)
    // and rejects an adult with NOT_A_MINOR.
    if (domainIsGated && age !== undefined && isMinorFromAge(age)) {
      setGuardianGate({ identifier, domain, age });
      return;
    }

    setIsSigningUp(true);
    // Terms/privacy must be accepted before the account is created. If the
    // gate opens, `handleConsentAccept` resumes here.
    const gated = await openConsentGateIfNeeded(identifier);
    if (gated) {
      setIsSigningUp(false);
      return;
    }
    await createAccountAndSignIn(identifier);
  };

  /**
   * Consent pre-check. Returns true when the modal is showing and signup
   * should pause. Fails open: a consent-service blip must not block
   * registration; the user is re-prompted on their next login.
   */
  const openConsentGateIfNeeded = async (identifier: AuthIdentifier): Promise<boolean> => {
    try {
      // Canonical E.164, or the exact-match lookup misses and re-prompts.
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

      const outstanding = buildOutstandingConsent({
        config: mergedConfig,
        network: themeId,
        brand,
        source: 'signup',
        accepted: consentStatus.statuses,
        // No variant: `status-by-identifier` is unauthenticated and does not
        // report one, so this is always the adult set. A minor gets the U18
        // documents post-auth from the guardian flow.
      });
      if (!outstanding) return false;

      setConsentGate({ ...outstanding, identifier });
      return true;
    } catch {
      // Fail open.
      return false;
    }
  };

  /**
   * Accepted in the modal. The accept endpoint is authenticated, so park the
   * acceptance for the callback page to flush once the session exists.
   */
  const handleConsentAccept = async () => {
    if (!consentGate) return;
    const { pendingConsent, identifier } = consentGate;
    // Bind the parked acceptance to this login: the id travels in the OIDC
    // `state`, so only this redirect's callback can consume it and an abandoned
    // round trip on a shared device is never written against the next user.
    const consentAttempt = newConsentAttemptId();
    if (consentAttempt) {
      setPendingConsent(pendingConsent, consentAttempt);
    } else {
      // No CSPRNG, so the acceptance cannot be bound. Park nothing (and drop
      // anything already parked); the gate re-prompts once signed in.
      clearPendingConsent();
    }
    setConsentGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier, consentAttempt ?? undefined);
  };

  /**
   * Guardian captured and verified. The guardian flow already recorded
   * terms/privacy as guardian-sourced, so the ordinary consent gate must not
   * run.
   */
  const handleGuardianComplete = async () => {
    if (!guardianGate) return;
    const { identifier } = guardianGate;
    setGuardianGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier);
  };

  const createAccountAndSignIn = async (identifier: AuthIdentifier, consentAttempt?: string) => {
    try {
      const result = await signupWithKeycloak({
        name: name.trim(),
        ...identifier,
        ...(domain ? { domain } : {}),
        ...(age !== undefined ? { age } : {}),
      });

      // Also park the fields client-side for the callback to write over an
      // authenticated session: the server's Redis stash has a 30-minute TTL and
      // fails silently. Both writes are idempotent.
      if (domain) {
        setPendingSignupExtras({ domain, ...(age !== undefined ? { age } : {}) });
      }

      // An identifier that is already taken needs no different action: sign in.
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
      await handleSignIn(consentAttempt);
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

  const modeBody =
    mode === 'choose' ? (
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

        {/* Invite-only instance: shown on arrival, before any identifier is
            entered, so it must not say the account was looked up and not
            found (`auth.signup_disabled_message`). */}
        {!canSignup && (
          <p className="pt-1 text-sm text-muted-foreground">
            {t('auth.signup_invite_only')}
          </p>
        )}
      </div>
    ) : (
      <div className="space-y-4">
        {/* Hidden when the instance runs a single channel. */}
        {channels.length > 1 && (
          <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSignupChannel(c);
                  setError(null);
                }}
                className={[
                  'flex-1 rounded-full py-1.5 font-medium transition-colors capitalize',
                  signupChannel === c
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                {c}
              </button>
            ))}
          </div>
        )}

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

        {/* Shown only for more than one served domain. */}
        {domainOptions.length > 1 && (
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{t('auth.label_domain')}</Label>
            {/* Segmented toggle. */}
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
                  {formatDomainLabel(d.id, networkDomains)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Only a guardian-gated domain needs an age; only the year is
            collected. */}
        {selectedDomainIsGated && (
          <div className="space-y-1.5">
            <Label htmlFor="signup-dob-year">{t('auth.signup_dob_label_ym')}</Label>
            <BirthYearSelect idPrefix="signup-dob" onChange={setAge} />
            <p className="text-xs text-muted-foreground">{t('auth.signup_dob_hint')}</p>
          </div>
        )}

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
    );

  return (
    <>
      {consentGate && (
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          variant={consentGate.variant}
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

      <SessionExpiredNotice />

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
          identifier={toSignupIdentifier(guardianGate.identifier)}
          age={guardianGate.age}
          onComplete={() => {
            void handleGuardianComplete();
          }}
        />
      ) : (
        modeBody
      )}
      </AuthShell>
    </>
  );
}

/**
 * One of the two entry choices. A button, not a link: both choices do work
 * (redirect to Keycloak, or swap the panel).
 */
function ChoiceCard({
  icon,
  title,
  description,
  emphasised = false,
  disabled,
  busy = false,
  onClick,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  description: string;
  emphasised?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}>) {
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
