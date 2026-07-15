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
import { MONTHS, buildYearOptions } from '@/lib/dob-options';
import type { SignupExtras } from '@/lib/signup-domain';

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
  const [birthMonth, setBirthMonth] = useState('');
  const [birthYear, setBirthYear] = useState('');
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
  const redirectTo = searchParams.get('redirect') ?? '/';
  const years = useMemo(() => buildYearOptions(), []);
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

  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber };
  const contactValue = mode === 'email' ? email : phoneNumber;
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

    // Client-side validation — server won't crash on a malformed number
    // but the OTP send will fail silently. Surface a clean inline error.
    if (mode === 'phone' && !isValidPhoneNumber(phoneNumber)) {
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

      // Domain confirmed here (Domain select is populated from the served
      // network's own schema — see the networkDomains effect above) + DOB
      // (month/year only) are required alongside the name for every new
      // signup, never for a returning user.
      if (!exists && (!name.trim() || !domain || !birthMonth || !birthYear)) {
        setIsLoading(false);
        toast.info(t('auth.toast_one_more_step'), {
          description: t('auth.toast_one_more_step_desc'),
        });
        return;
      }

      const resolvedName = exists ? '' : name;
      const resolvedSignupExtras: SignupExtras | null = exists
        ? null
        : { domain, birthMonth: Number(birthMonth), birthYear: Number(birthYear) };

      // Evaluate consent before sending the OTP. This is best-effort (public
      // endpoint, client-side); on any failure we proceed without gating — the
      // user will be re-prompted post-verify on the next login (spec §1.1).
      try {
        // Normalize the phone to the canonical E.164 form auth stores; otherwise
        // the exact-match lookup in status-by-identifier misses a returning user
        // and the T&C gate re-prompts every login (see consentStatusIdentifier).
        const identifierParam = consentStatusIdentifier(identifier);

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
            setPendingIdentifier(identifier);
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

      await proceedToOtp(identifier, exists, resolvedName, resolvedSignupExtras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
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
              {mode === 'email'
                ? t(onlyEmail ? 'auth.label_email' : 'auth.label_email_or_mobile')
                : t('auth.label_mobile')}
            </Label>
            {mode === 'phone' ? (
              <Input
                id="contact"
                type="tel"
                placeholder={t('auth.placeholder_phone')}
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={isLoading}
                required
                className="h-11"
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
              <p className="text-xs text-muted-foreground">
                {mode === 'email'
                  ? t('auth.hint_verify_email')
                  : t('auth.hint_verify_phone')}
              </p>
            </div>
          )}

          {/* Domain + DOB — captured once, at signup, alongside the name.
              Domain is confirmed here; DOB (month/year only) is persisted
              post-OTP-verify via submitU18Dob (see otp-page.tsx). */}
          {userExists === false && !signupBlocked && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="signup-domain" className="text-sm font-medium">
                  {t('auth.label_domain', 'I am a')}
                </Label>
                <select
                  id="signup-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  disabled={isLoading}
                  required
                  className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="" disabled>
                    {t('auth.domain_placeholder', 'Select one')}
                  </option>
                  {domainOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {domainLabel(d)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  {t('auth.label_dob', 'Date of birth (month & year)')}
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <select
                    id="signup-dob-month"
                    aria-label={t('auth.dob_label_month', 'Birth month')}
                    value={birthMonth}
                    onChange={(e) => setBirthMonth(e.target.value)}
                    disabled={isLoading}
                    required
                    className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <option value="" disabled>
                      {t('auth.dob_month_placeholder', 'Month')}
                    </option>
                    {MONTHS.map((label, idx) => (
                      <option key={label} value={idx + 1}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    id="signup-dob-year"
                    aria-label={t('auth.dob_label_year', 'Birth year')}
                    value={birthYear}
                    onChange={(e) => setBirthYear(e.target.value)}
                    disabled={isLoading}
                    required
                    className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <option value="" disabled>
                      {t('auth.dob_year_placeholder', 'Year')}
                    </option>
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {signupBlocked && (
            <p className="text-sm text-destructive">
              {t('auth.signup_disabled_message')}
            </p>
          )}

          {/* CTA */}
          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {(userExists === null || signupBlocked) ? t('auth.cta_continue') : t('auth.cta_send_otp')}
          </button>
        </form>
      </AuthShell>
    </>
  );
}
