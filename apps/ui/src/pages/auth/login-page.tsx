import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/layout/auth-shell';
import {
  checkUser,
  consentStatusIdentifier,
  fetchAuthConfig,
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
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';
import { toast } from 'sonner';
import { fetchNetworkConfig } from '@/lib/network-api';
import type { DotNetworkDomain } from '@/engine/types';
import { getServedScope } from '@/lib/served-binding';
import type { SignupExtras } from '@/lib/signup-domain';
import { SignupDobStep } from '@/components/consent/u18/signup-dob-step';
import { isMinorFromDate } from '@/lib/guardian-consent';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';

type AuthMode = 'phone' | 'email';

type PendingConsent = ConsentAcceptBody;

interface ConsentGateState {
  config: ConsentConfigDocument;
  pendingConsent: PendingConsent;
}

function domainLabel(domain: DotNetworkDomain): string {
  return domain.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}


export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { t } = useTranslation();
  const { themeId, brand } = useNetworkTheme();

  useEffect(() => {
    const wrongPortalDomain = (location.state as { wrongPortalDomain?: string } | null)?.wrongPortalDomain;
    if (wrongPortalDomain) {
      // Stable id so the toast is de-duped if this effect runs more than once
      // (e.g. React StrictMode double-invokes it in dev) — one visible toast.
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
  const [authCfg, setAuthCfg] = useState<AuthConfigResponse | null>(null);
  const [signupBlocked, setSignupBlocked] = useState(false);
  const [networkDomains, setNetworkDomains] = useState<DotNetworkDomain[]>([]);
  // Capture the checked identifier at the time of submission so the consent
  // accept and OTP request use the same normalized values.
  const [pendingIdentifier, setPendingIdentifier] = useState<AuthIdentifier | null>(null);
  const [pendingUserExists, setPendingUserExists] = useState<boolean>(false);
  const [pendingName, setPendingName] = useState<string>('');
  const [pendingSignupExtras, setPendingSignupExtras] = useState<SignupExtras | null>(null);
  // Set only for a brand-new MINOR signup in a guardian-gated domain — renders
  // the pre-auth SignupGuardianFlow and defers the ward's own OTP until the
  // guardian is verified (U18 option A). null for every other path.
  const [signupGuardianGate, setSignupGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    dateOfBirth: Date;
    resolvedName: string;
    resolvedSignupExtras: SignupExtras;
    /** true = an EXISTING user backfilling DOB before login (not a new signup). */
    exists: boolean;
  } | null>(null);
  // Set for a guardian-gated (u18-enabled) domain — renders the DOB step. For a
  // brand-new signup it's AFTER the name/domain form; for an existing user
  // missing DOB it's after the phone check, BEFORE the login OTP.
  const [signupDobGate, setSignupDobGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    resolvedName: string;
    exists: boolean;
  } | null>(null);
  const redirectTo = searchParams.get('redirect') ?? '/';
  const servedScope = useMemo(() => getServedScope(), []);

  useEffect(() => {
    fetchAuthConfig()
      .then(setAuthCfg)
      // Fail-safe: assume both channels + gated so the API stays authoritative.
      .catch(() => setAuthCfg({ selfSignupAllowed: false, loginChannels: ['phone', 'email'] }));
  }, []);

  // Domain options for the signup form's domain select. Fetched from the
  // served network's own schema (network.domains) — not user input — so the
  // domain a signup submits is always one the network actually defines.
  useEffect(() => {
    fetchNetworkConfig(themeId)
      .then((cfg) => setNetworkDomains(cfg.domains ?? []))
      .catch(() => setNetworkDomains([]));
  }, [themeId]);

  // Restrict to the served set when this deployment is bound to a subset of
  // domains (single- or multi-domain portal) — mirrors profile-form-page's
  // own domain-picker scoping so a signup can't pick a domain this portal
  // doesn't serve.
  const domainOptions = servedScope
    ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
    : networkDomains;

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
  // Gate the CTA: in phone mode the full 10-digit national number must be in;
  // in email mode a non-empty value. Keeps "Continue" disabled until then.
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
        // Only ever set for a brand-new signup — otp-page uses its presence
        // (not userExists alone) to decide whether to run submitU18Dob.
        signupExtras: resolvedSignupExtras,
      },
    });
  };

  const handleConsentAccept = async () => {
    if (!consentGate || !pendingIdentifier) return;
    // Capture locals and close the modal immediately to prevent re-entry
    // from a double-click before the async OTP request completes.
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
  // Best-effort: on any pre-check failure we proceed without gating — the user
  // is re-prompted post-verify on their next login (spec §1.1). Adults reach
  // this from the signup form (ungated) or after the DOB step (gated-adult);
  // minors never do (the guardian flow records their consent instead).
  const runConsentThenOtp = async (
    ident: AuthIdentifier,
    exists: boolean,
    resolvedName: string,
    resolvedSignupExtras: SignupExtras | null,
  ) => {
    try {
      // Normalize the phone to the canonical E.164 form auth stores; otherwise
      // the exact-match lookup in status-by-identifier misses a returning user
      // and the T&C gate re-prompts every login (see consentStatusIdentifier).
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

        const needed = (['terms', 'privacy'] as const).filter(
          (c) => !consentStatus.statuses[c].includes(mergedConfig.documents[c].current_version),
        );

        if (needed.length > 0) {
          setPendingIdentifier(ident);
          setPendingUserExists(exists);
          setPendingName(resolvedName);
          setPendingSignupExtras(resolvedSignupExtras);
          setConsentGate({
            config: mergedConfig,
            pendingConsent: {
              network: themeId,
              brand: brand !== 'standard' ? brand : null,
              source: exists ? 'login' : 'signup',
              items: needed.map((c) => ({
                category: c,
                version: mergedConfig.documents[c].current_version,
              })),
            },
          });
          // Do NOT send OTP yet — wait for accept.
          setIsLoading(false);
          return;
        }
      }
    } catch {
      // Consent pre-check failed — fail-open, proceed to OTP without gating.
      // The user will be re-prompted post-verify on their next login.
    }

    await proceedToOtp(ident, exists, resolvedName, resolvedSignupExtras);
  };

  // Resolve the DOB step: minor -> guardian flow (before their own OTP);
  // adult -> ordinary consent + OTP. DOB (month/year) rides along in
  // signupExtras so otp-page persists it post-verify.
  const handleSignupDob = async (date: Date) => {
    const gate = signupDobGate;
    if (!gate) return;
    const extras: SignupExtras = { domain: gate.domain, dateOfBirth: date.toISOString() };
    setSignupDobGate(null);

    // A brand-new minor signup captures the guardian pre-auth (materialized on
    // account creation — safe, same session owns the new identifier). An
    // EXISTING user must NOT designate a guardian before proving they own the
    // number (login OTP), so their guardian step runs post-login on the home
    // page; here we only persist the DOB and proceed to the login OTP.
    if (isMinorFromDate(date) && !gate.exists) {
      toast.info(t('auth.minor_toast_title', "You're under 18"), {
        description: t(
          'auth.minor_toast_desc',
          'A parent or guardian needs to confirm your account before you can continue.',
        ),
      });
      setSignupGuardianGate({
        identifier: gate.identifier,
        domain: gate.domain,
        dateOfBirth: date,
        resolvedName: gate.resolvedName,
        resolvedSignupExtras: extras,
        exists: gate.exists,
      });
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

    // Client-side validation — server won't crash on a malformed number
    // but the OTP send will fail silently. Surface a clean inline error.
    if (mode === 'phone' && !isValidPhoneNumber(fullPhone)) {
      toast.error(t('auth.toast_invalid_phone'), {
        description: t('auth.toast_invalid_phone_desc'),
      });
      return;
    }
    if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await checkUser(identifier);
      const exists = response.userExists;
      setUserExists(exists);
      setSignupBlocked(false);

      if (!exists && authCfg && !authCfg.selfSignupAllowed) {
        setIsLoading(false);
        toast.error(t('auth.toast_signup_disabled'), {
          description: t('auth.toast_signup_disabled_desc'),
        });
        setSignupBlocked(true);
        return;
      }

      // Domain is confirmed on the signup form (select populated from the
      // served network's own schema — see the networkDomains effect above),
      // alongside the name. DOB is NOT asked here: it's a separate step shown
      // only for guardian-gated domains (below), never for a returning user.
      if (!exists && (!name.trim() || !domain)) {
        setIsLoading(false);
        toast.info(t('auth.toast_one_more_step'), {
          description: t('auth.toast_one_more_step_desc', { contactLabel }),
        });
        return;
      }

      const resolvedName = exists ? '' : name;

      // A brand-new signup in a guardian-gated (u18-enabled) domain collects
      // DOB in a SEPARATE next step. Ungated domains (e.g. provider) skip DOB
      // entirely and go straight to consent + OTP. The server stays
      // authoritative on minor + gated + served.
      const gatedDomain =
        !exists && (networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false);
      if (gatedDomain) {
        setSignupDobGate({ identifier, domain, resolvedName, exists: false });
        setIsLoading(false);
        return; // DOB step renders next; no OTP yet.
      }

      // EXISTING user missing a DOB on a gated domain: collect DOB (+ guardian,
      // for minors) BEFORE the login OTP — same steps as signup, but the
      // capture is materialized onto the existing user right after OTP verify.
      if (exists) {
        try {
          const pre = await u18Precheck(themeId, identifier);
          if (pre.requiresDob) {
            // DOB only (no domain needed) — the guardian step, if any, runs
            // post-login on the home page once the login OTP proves ownership.
            setSignupDobGate({ identifier, domain: '', resolvedName: '', exists: true });
            setIsLoading(false);
            return; // DOB step renders next; no OTP yet.
          }
        } catch {
          // Fail-open: precheck failure must not block login — the home-page
          // gate still catches a minor who slips through.
        }
      }

      // Non-gated / returning user: runConsentThenOtp runs the same terms/privacy
      // pre-check (getConsentStatusByIdentifier) before sending the OTP.
      const resolvedSignupExtras: SignupExtras | null = exists ? null : { domain };
      await runConsentThenOtp(identifier, exists, resolvedName, resolvedSignupExtras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // While the DOB step or the guardian flow is active, the signup form is
  // hidden so the step reads as its own page (auth background only) rather
  // than stacking over the half-filled form.
  const showSignupForm = !signupDobGate && !signupGuardianGate;

  // Guardian verified — send the ward's own OTP. No pendingConsent: the
  // minor's terms/privacy are recorded guardian-sourced on account creation
  // (materializeSignupGuardian), not via the adult gate.
  const handleGuardianComplete = () => {
    const gate = signupGuardianGate;
    if (!gate) return;
    setSignupGuardianGate(null);
    // The guardian step and the ward's own verification are separate — make the
    // hand-off explicit so the jump to the user OTP screen isn't a surprise.
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
          onAccept={() => { void handleConsentAccept(); }}
        />
      )}
      <AuthShell>
        {signupDobGate ? (
          <SignupDobStep onSubmit={(date) => { void handleSignupDob(date); }} />
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
            dateOfBirth={signupGuardianGate.dateOfBirth}
            onComplete={handleGuardianComplete}
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

          {/* Domain — confirmed at signup alongside the name (select populated
              from the served network's own schema). DOB is NOT asked here: it's
              a separate step shown only for guardian-gated domains. */}
          {userExists === false && !signupBlocked && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t('auth.label_domain', 'Your Domain')}
              </Label>
              {/* Segmented toggle, same style as the phone/email pills. */}
              <div className="flex flex-wrap gap-1 rounded-full border border-border bg-muted p-1 text-sm">
                {domainOptions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDomain(d.id)}
                    disabled={isLoading}
                    className={[
                      'flex-1 rounded-full py-1.5 px-3 font-medium transition-colors capitalize whitespace-nowrap',
                      domain === d.id
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    ].join(' ')}
                  >
                    {domainLabel(d)}
                  </button>
                ))}
              </div>
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
            {/* "Send OTP" only for a returning user, where submit truly sends
                the code. A new signup submit leads to more steps (DOB /
                guardian / consent) before any OTP, so it reads "Continue". */}
            {userExists === true ? t('auth.cta_send_otp') : t('auth.cta_continue')}
          </button>
        </form>
        </>
        )}
      </AuthShell>
    </>
  );
}
