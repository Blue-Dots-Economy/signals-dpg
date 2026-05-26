import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/layout/auth-shell';
import { checkUser, requestOtp, type AuthIdentifier } from '@/lib/auth-api';
import { toast } from 'sonner';

type AuthMode = 'phone' | 'email';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [userExists, setUserExists] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const redirectTo = searchParams.get('redirect') ?? '/';

  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber };
  const contactValue = mode === 'email' ? email : phoneNumber;
  const contactLabel = mode === 'email' ? 'email address' : 'phone number';

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    setUserExists(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

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
          toast.info('One more step', {
            description: 'Enter your name below to finish setting up your account.',
          });
          return;
        }
        await requestOtp(identifier);
        navigate('/auth/otp', {
          state: { ...identifier, userExists: exists, name, redirectTo },
        });
      }
    } catch {
      toast.error('Couldn\'t send verification code', {
        description: 'Check your connection and make sure the number or email is correct, then try again.',
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
        Back
      </button>

      {/* Heading */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground">
          {userExists === null
            ? 'Sign in'
            : userExists
              ? 'Welcome back'
              : 'Create your account'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {userExists === null
            ? 'Continue with email or mobile to receive a verification code'
            : userExists
              ? `Enter your ${contactLabel} to sign in`
              : `Enter your ${contactLabel} and name to get started`}
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
            {mode === 'email' ? 'Email or mobile number' : 'Mobile number'}
          </Label>
          {mode === 'phone' ? (
            <Input
              id="contact"
              type="tel"
              placeholder="+91 98765 43210"
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
              placeholder="name@example.in"
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
              Your name
            </Label>
            <Input
              id="name"
              type="text"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isLoading}
              required
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              {mode === 'email'
                ? "We'll send a one-time code to verify your email."
                : "We'll send a one-time code to verify your number."}
            </p>
          </div>
        )}

        {/* CTA */}
        <button
          type="submit"
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
        >
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {userExists === null ? 'Continue' : 'Send OTP'}
        </button>
      </form>
    </AuthShell>
  );
}
