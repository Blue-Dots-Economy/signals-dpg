import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { OtpInput } from '@/components/auth/otp-input';
import { AuthShell } from '@/components/layout/auth-shell';
import { requestOtp, type AuthIdentifier } from '@/lib/auth-api';
import { useAuth } from '@/contexts/auth-context';
import { toast } from 'sonner';

interface AuthState extends AuthIdentifier {
  userExists: boolean;
  name?: string;
  redirectTo?: string;
}

function getAuthIdentifier(state: AuthState): AuthIdentifier {
  return state.email ? { email: state.email } : { phoneNumber: state.phoneNumber };
}

export function OtpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { verifyOtp } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);

  const state = location.state as AuthState | null;
  const identifierLabel = state?.email ?? state?.phoneNumber;

  useEffect(() => {
    if (!identifierLabel) {
      navigate('/auth/login');
      return;
    }
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(interval); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [countdown, identifierLabel, navigate]);

  const handleOtpComplete = async (otp: string) => {
    if (!state || !identifierLabel) return;
    setIsLoading(true);
    try {
      await verifyOtp(getAuthIdentifier(state), otp, state.userExists ? undefined : state.name);
      toast.success(state.userExists ? 'Welcome back!' : 'Account created successfully!');
      navigate(state.redirectTo ?? '/', { replace: true });
    } catch {
      toast.error('Invalid OTP. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!state || !identifierLabel || countdown > 0) return;
    setIsLoading(true);
    try {
      await requestOtp(getAuthIdentifier(state));
      setCountdown(60);
      toast.success('OTP resent successfully');
    } catch {
      toast.error('Failed to resend OTP');
    } finally {
      setIsLoading(false);
    }
  };

  if (!identifierLabel) return null;

  return (
    <AuthShell>
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/auth/login')}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      {/* Heading */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-foreground">Enter verification code</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          We sent a 6-digit code to{' '}
          <span className="font-medium text-foreground">{identifierLabel}</span>
        </p>
      </div>

      {/* OTP input */}
      <div className="flex justify-center mb-6">
        <OtpInput onComplete={handleOtpComplete} disabled={isLoading} />
      </div>

      {isLoading && (
        <div className="flex justify-center mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      )}

      {/* Resend */}
      <div className="text-center text-sm">
        {countdown > 0 ? (
          <p className="text-muted-foreground">Resend code in {countdown}s</p>
        ) : (
          <button
            type="button"
            onClick={handleResendOtp}
            disabled={isLoading}
            className="text-primary hover:underline disabled:opacity-50"
          >
            Resend code
          </button>
        )}
      </div>
    </AuthShell>
  );
}
