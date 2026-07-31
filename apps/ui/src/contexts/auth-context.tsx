import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSession, signOut as apiSignOut, type AuthIdentifier, type User } from '@/lib/auth-api';
import { setAuthToken, clearAuthToken } from '@/lib/auth-token';
import { clearSchemaCache } from '@/engine';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  checkUser: (identifier: AuthIdentifier) => Promise<boolean>;
  requestOtp: (identifier: AuthIdentifier) => Promise<void>;
  verifyOtp: (identifier: AuthIdentifier, otp: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const fetchSession = useCallback(async () => {
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

  const verifyOtp = useCallback(async (identifier: AuthIdentifier, otp: string, name?: string): Promise<void> => {
    const { verifyOtp: verifyOtpApi } = await import('@/lib/auth-api');
    const response = await verifyOtpApi(identifier, otp, name);
    setAuthToken(response.token);
    setUser(response.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiSignOut();
    } finally {
      clearAuthToken();
      setUser(null);
      clearSchemaCache();
      // Drop the signed-out user's cached data so it doesn't linger until
      // gcTime and bleed into the next session (SPA sign-out does not reload
      // the page). All four hold per-user data: my-items + edit-item are the
      // user's own items; profile-consent is their accepted profiles; actions
      // covers their applications/connections — including pendingCount, whose
      // key is NOT network/user-scoped, so a stale count would otherwise show
      // to the next user on re-login. browse-items/markers/*-config are public
      // network-scoped data and can stay.
      queryClient.removeQueries({ queryKey: ['my-items'] });
      queryClient.removeQueries({ queryKey: ['profile-consent'] });
      queryClient.removeQueries({ queryKey: ['edit-item'] });
      queryClient.removeQueries({ queryKey: ['actions'] });
    }
  }, [queryClient]);

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
