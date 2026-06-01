import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AuthShell } from '@/components/layout/auth-shell';
import {
  checkUser,
  isValidPhoneNumber,
  requestOtp,
  type AuthIdentifier,
} from '@/lib/auth-api';
import { fetchNetworkConfigs } from '@/lib/network-api';
import type { DotNetworkSchema } from '@/engine/types';
import { toast } from 'sonner';

type AuthMode = 'phone' | 'email';

const NONE = '__none__';

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

  // All served networks — signup shows one role dropdown per network so
  // multi-dot deployments let the user pick a role in each network they
  // want to join (or skip). Stored as map { network: domain | '' }; on
  // submit we serialize to ["network/domain", ...].
  const [networks, setNetworks] = useState<DotNetworkSchema[]>([]);
  const [domainByNetwork, setDomainByNetwork] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (userExists !== false) return;
    if (networks.length > 0) return;
    fetchNetworkConfigs()
      .then((cfgs) => setNetworks(cfgs))
      .catch(() => {
        /* picker hides itself when list stays empty */
      });
  }, [userExists, networks.length]);

  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber };
  const contactValue = mode === 'email' ? email : phoneNumber;
  const contactLabel = mode === 'email' ? 'email address' : 'phone number';

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    setUserExists(null);
  };

  const selectedBindings = Object.entries(domainByNetwork)
    .filter(([, d]) => d && d !== NONE)
    .map(([n, d]) => `${n}/${d}`);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

    // Client-side validation — server won't crash on a malformed number
    // but the OTP send will fail silently. Surface a clean inline error.
    if (mode === 'phone' && !isValidPhoneNumber(phoneNumber)) {
      toast.error('Invalid mobile number', {
        description:
          'Enter a 10-digit Indian mobile number (must start with 6, 7, 8, or 9). +91 prefix is optional.',
      });
      return;
    }
    if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error('Invalid email', {
        description: 'Enter a valid email address (e.g. name@example.com).',
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
          toast.info('One more step', {
            description: 'Enter your name below to finish setting up your account.',
          });
          return;
        }
        if (selectedBindings.length === 0) {
          setIsLoading(false);
          toast.info('Pick at least one role', {
            description:
              'Select your role in at least one network to continue.',
          });
          return;
        }
        await requestOtp(identifier);
        navigate('/auth/otp', {
          state: {
            ...identifier,
            userExists: exists,
            name,
            redirectTo,
            domains: selectedBindings,
          },
        });
      }
    } catch {
      toast.error('Couldn\'t send verification code', {
        description:
          "Check your connection and make sure the number or email is correct, then try again.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell>
      <button
        type="button"
        onClick={() => navigate('/')}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

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
              : `Enter your ${contactLabel} and pick your role in each network`}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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

        {userExists === false && (
          <>
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
            {networks.length === 0 ? (
              <p className="text-xs text-muted-foreground">Loading networks…</p>
            ) : (
              networks.map((n) => {
                const value = domainByNetwork[n.id] ?? '';
                const displayName = n.display_name ?? n.id;
                const singleNetwork = networks.length === 1;
                // Single-network deploys: role is required, no skip option.
                // Multi-network deploys: each network is optional with a
                // skip entry, so the user can join only the ones they want.
                return (
                  <div key={n.id} className="space-y-1.5">
                    <Label
                      htmlFor={`domain-${n.id}`}
                      className="text-sm font-medium"
                    >
                      {singleNetwork ? 'Your role' : `${displayName} role`}
                    </Label>
                    <Select
                      value={value}
                      onValueChange={(v) =>
                        setDomainByNetwork((prev) => ({
                          ...prev,
                          [n.id]: v === NONE ? '' : v,
                        }))
                      }
                      disabled={isLoading}
                    >
                      <SelectTrigger id={`domain-${n.id}`} className="h-11 w-full">
                        <SelectValue
                          placeholder={
                            singleNetwork ? 'Select your role' : 'Select role or skip'
                          }
                        >
                          {value ? (
                            <span className="capitalize">{value}</span>
                          ) : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent
                        position="popper"
                        className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]"
                      >
                        {!singleNetwork && (
                          <SelectItem value={NONE} textValue="Skip this network">
                            <span className="text-muted-foreground">
                              — Skip this network —
                            </span>
                          </SelectItem>
                        )}
                        {(n.domains ?? []).map((d) => (
                          <SelectItem
                            key={d.id}
                            value={d.id}
                            textValue={d.id}
                            className="py-2"
                          >
                            <div className="flex flex-col gap-0.5 text-left">
                              <span className="capitalize font-medium leading-tight">
                                {d.id}
                              </span>
                              {d.description ? (
                                <span className="text-xs text-muted-foreground leading-snug whitespace-normal break-words">
                                  {d.description}
                                </span>
                              ) : null}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            )}
          </>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
        >
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {userExists === null ? 'Continue' : 'Send OTP'}
        </button>
      </form>
    </AuthShell>
  );
}
