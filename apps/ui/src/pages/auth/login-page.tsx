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
import { toast } from 'sonner';

type AuthMode = 'phone' | 'email';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { t } = useTranslation();

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

      if (exists) {
        await requestOtp(identifier);
        navigate('/auth/otp', {
          state: { ...identifier, userExists: exists, name: '', redirectTo },
        });
      } else {
        if (!name.trim()) {
          setIsLoading(false);
          toast.info(t('auth.toast_one_more_step'), {
            description: t('auth.toast_one_more_step_desc'),
          });
          return;
        }
        await requestOtp(identifier);
        navigate('/auth/otp', {
          state: { ...identifier, userExists: exists, name, redirectTo },
        });
      }
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
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
  );
}
