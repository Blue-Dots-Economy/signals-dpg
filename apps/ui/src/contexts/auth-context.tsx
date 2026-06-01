import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getSession, signOut as apiSignOut, type AuthIdentifier, type User } from '@/lib/auth-api';
import { setAuthToken, clearAuthToken } from '@/lib/auth-token';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  checkUser: (identifier: AuthIdentifier) => Promise<boolean>;
  requestOtp: (identifier: AuthIdentifier) => Promise<void>;
  verifyOtp: (
    identifier: AuthIdentifier,
    otp: string,
    name?: string,
    domains?: string[],
  ) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Re-fetches /api/auth/get-session and updates the context. Use after
   * mutating fields on the user row (e.g. joining a network) so the new
   * value flows into useMyNetworks without a page reload.
   */
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchSession = useCallback(async () => {
    // Mark loading BEFORE the await so consumers (e.g. NetworkJoinGate)
    // that gate on isLoading don't briefly re-render with the prior
    // user state between a refreshSession() call and the GET completing.
    setIsLoading(true);
    try {
      const session = await getSession();
      if (session.token) {
        setAuthToken(session.token);
      }
      setUser(session.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  const checkUser = useCallback(async (identifier: AuthIdentifier): Promise<boolean> => {
    const { checkUser: checkUserApi } = await import('@/lib/auth-api');
    const response = await checkUserApi(identifier);
    return response.userExists;
  }, []);

  const requestOtp = useCallback(async (identifier: AuthIdentifier): Promise<void> => {
    const { requestOtp: requestOtpApi } = await import('@/lib/auth-api');
    await requestOtpApi(identifier);
  }, []);

  const verifyOtp = useCallback(
    async (
      identifier: AuthIdentifier,
      otp: string,
      name?: string,
      domains?: string[],
    ): Promise<void> => {
      const { verifyOtp: verifyOtpApi } = await import('@/lib/auth-api');
      const response = await verifyOtpApi(identifier, otp, name, domains);
      setAuthToken(response.token);
      setUser(response.user);
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await apiSignOut();
    } finally {
      clearAuthToken();
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        checkUser,
        requestOtp,
        verifyOtp,
        signOut,
        refreshSession: fetchSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
