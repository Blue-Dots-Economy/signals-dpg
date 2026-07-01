import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/layout/auth-shell';
import {
  checkUser,
  isValidPhoneNumber,
  requestOtp,
  type AuthIdentifier,
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

type AuthMode = 'phone' | 'email';

type PendingConsent = ConsentAcceptBody;

interface ConsentGateState {
  config: ConsentConfigDocument;
  pendingConsent: PendingConsent;
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
  const [userExists, setUserExists] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [consentGate, setConsentGate] = useState<ConsentGateState | null>(null);
  // Capture the checked identifier at the time of submission so the consent
  // accept and OTP request use the same normalized values.
  const [pendingIdentifier, setPendingIdentifier] = useState<AuthIdentifier | null>(null);
  const [pendingUserExists, setPendingUserExists] = useState<boolean>(false);
  const [pendingName, setPendingName] = useState<string>('');
  const redirectTo = searchParams.get('redirect') ?? '/';

  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber };
  const contactValue = mode === 'email' ? email : phoneNumber;
  const contactLabel = mode === 'email'
    ? t('auth.contact_label_email')
    : t('auth.contact_label_phone');

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    setUserExists(null);
  };

  const proceedToOtp = async (
    resolvedIdentifier: AuthIdentifier,
    resolvedUserExists: boolean,
    resolvedName: string,
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
    setConsentGate(null);
    try {
      await proceedToOtp(ident, userEx, uname, gate.pendingConsent);
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

      if (!exists && !name.trim()) {
        setIsLoading(false);
        toast.info(t('auth.toast_one_more_step'), {
          description: t('auth.toast_one_more_step_desc'),
        });
        return;
      }

      const resolvedName = exists ? '' : name;

      // Evaluate consent before sending the OTP. This is best-effort (public
      // endpoint, client-side); on any failure we proceed without gating — the
      // user will be re-prompted post-verify on the next login (spec §1.1).
      try {
        const identifierParam: { phone?: string; email?: string } = {};
        if (identifier.email) identifierParam.email = identifier.email;
        if (identifier.phoneNumber) identifierParam.phone = identifier.phoneNumber;

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

      await proceedToOtp(identifier, exists, resolvedName);
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
          initialTab="terms"
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
            {userExists === null
              ? t('auth.heading_sign_in')
              : userExists
                ? t('auth.heading_welcome_back')
                : t('auth.heading_create_account')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {userExists === null
              ? t('auth.sub_initial')
              : userExists
                ? t('auth.sub_existing', { contactLabel })
                : t('auth.sub_new', { contactLabel })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Phone / Email pill toggle */}
          <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
            {(['phone', 'email'] as AuthMode[]).map((m) => (
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

          {/* Contact input */}
          <div className="space-y-1.5">
            <Label htmlFor="contact" className="text-sm font-medium">
              {mode === 'email' ? t('auth.label_email_or_mobile') : t('auth.label_mobile')}
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

          {/* Name — only shown when creating account */}
          {userExists === false && (
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

          {/* CTA */}
          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {userExists === null ? t('auth.cta_continue') : t('auth.cta_send_otp')}
          </button>
        </form>
      </AuthShell>
    </>
  );
}
