import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  getSession,
  fetchMe,
  signOut as apiSignOut,
  type AuthIdentifier,
  type MeResponse,
  type User,
} from '@/lib/auth-api';
import {
  clearCsrfToken,
  endBffSession,
  fetchBffSession,
  startBffLogin,
} from '@/lib/bff-session';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { QueryClient } from '@tanstack/react-query';
import { clearSchemaCache } from '@/engine';
import { useAuthConfig } from '@/hooks/use-auth-config';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when this deployment logs in through Keycloak rather than OTP. */
  isKeycloakLogin: boolean;
  checkUser: (identifier: AuthIdentifier) => Promise<boolean>;
  requestOtp: (identifier: AuthIdentifier) => Promise<void>;
  verifyOtp: (identifier: AuthIdentifier, otp: string, name?: string) => Promise<void>;
  /** Redirect to Keycloak. Only meaningful when `isKeycloakLogin`. */
  startKeycloakLogin: (returnTo?: string, consentAttempt?: string) => Promise<void>;
  /** Adopt the session established by the OIDC callback page. */
  completeKeycloakLogin: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Maps `/api/v1/auth/me` (identity plus role) onto the wider `User` type, filling
 * the rest with values true of a signed-in Keycloak user so consumers need no
 * null checks. `emailVerified` follows the presence of an email because Keycloak
 * does not complete an OTP login against an unverified identifier; `banned` is
 * false because provisioning refuses a banned user before this point.
 */
function meToUser(me: MeResponse): User {
  const now = new Date().toISOString();
  return {
    id: me.id,
    name: me.name,
    email: me.email || null,
    emailVerified: Boolean(me.email),
    phoneNumber: null,
    phoneNumberVerified: false,
    image: '',
    role: me.role ?? 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: now,
    updatedAt: now,
    firstLogin: me.first_login,
  };
}

/**
 * Drops the signed-out user's cached data so it cannot bleed into the next
 * session (an SPA sign-out does not reload the page). These keys hold per-user
 * data. `actions` includes the pending count and `consent-status` is keyed by
 * network only, so without eviction the next user on the device would briefly
 * see the previous user's count and consent status (letting the U18 guardian
 * gate skip its documents). Browse, markers and config queries are public and
 * stay.
 */
function evictPerUserQueries(queryClient: QueryClient): void {
  for (const key of ['my-items', 'profile-consent', 'edit-item', 'actions', 'consent-status']) {
    queryClient.removeQueries({ queryKey: [key] });
  }
}

/**
 * "Leave `user` as it is." Distinct from `null`, which asserts the session is
 * gone: the difference between a dependency blip and a logout.
 */
export const HOLD = Symbol('hold');

/**
 * Who the BFF session belongs to, or `HOLD` when state must not change.
 * `superseded` is checked between requests so a login that lands mid-flight
 * short-circuits before `/auth/me`.
 *
 * Exported for tests: through the provider, holding and asserting null look the
 * same from a cold start.
 */
export async function resolveKeycloakUser(
  superseded: () => boolean,
): Promise<User | null | typeof HOLD> {
  // The session is an httpOnly cookie, so ask the BFF rather than read anything
  // from the page.
  const session = await fetchBffSession();
  if (superseded()) return HOLD;
  // The API could not answer (outage, offline): hold rather than sign the user
  // out over a blip. See `BffSession.unknown`.
  if (session.unknown) return HOLD;
  if (!session.authenticated) return null;
  return meToUser(await fetchMe());
}

/**
 * True when a failure says nothing about whether the session is valid. The API
 * answers a dependency outage with 503 so a Keycloak restart is not a fleet-wide
 * logout; a request with no response (offline, DNS, aborted) is the same class.
 * Anything else, notably a 401, is a real answer and signs the user out.
 */
function isTransientAuthFailure(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status >= 500;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  // The login provider comes from the API's auth config.
  const { isKeycloakLogin, isLoading: isConfigLoading } = useAuthConfig();
  const { t } = useTranslation();

  /**
   * Restores an existing session on mount by asking the server. Waits for the
   * auth config, because that decides which session endpoint to ask.
   */

  /**
   * Bumped whenever a login explicitly establishes the user (OIDC callback or
   * OTP verify). `fetchSession` discards its result if the epoch changed while
   * it awaited, so a slow mount-time restore resolving to null cannot sign out
   * a user the callback page has just established.
   */
  const authEpochRef = useRef(0);

  const fetchSession = useCallback(async () => {
    if (isConfigLoading) return;
    const epoch = authEpochRef.current;
    /** A login landed while awaiting; its user is newer than ours. */
    const superseded = () => epoch !== authEpochRef.current;
    try {
      const next = isKeycloakLogin
        ? await resolveKeycloakUser(superseded)
        : (await getSession()).user;
      if (superseded()) return;
      if (next !== HOLD) setUser(next);
    } catch (err) {
      if (superseded()) return;
      // Only a definitive answer signs the user out; a 5xx or transport failure
      // leaves `user` alone.
      if (isTransientAuthFailure(err)) return;
      setUser(null);
    } finally {
      // Superseded means a login already owns the state, including isLoading.
      if (!superseded()) setIsLoading(false);
    }
  }, [isConfigLoading, isKeycloakLogin]);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  // Terminal session expiry, raised by `api-client.ts` on a 401 that means the
  // session is gone (`TOKEN_EXPIRED`, or `UNAUTHORIZED` while a CSRF token is
  // held).
  //
  // `setUser(null)` is what stops the traffic: every polling query carries
  // `enabled: isAuthenticated`, so dropping the user disables them at source.
  // `cancelQueries` aborts in-flight requests and `removeQueries` drops the
  // cache, so a signed-out page cannot render the previous user's data.
  //
  // `window.location` rather than `useNavigate`: `AuthProvider` wraps
  // `BrowserRouter` (`app.tsx`), so there is no router context here, and a full
  // navigation guarantees no stale in-memory state survives.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void import('@/lib/auth-events').then(({ onSessionExpired }) => {
      if (cancelled) return;
      unsubscribe = onSessionExpired(() => {
        // The in-memory CSRF token is what stands for a live session.
        clearCsrfToken();
        authEpochRef.current += 1;
        setUser(null);
        void queryClient.cancelQueries();
        queryClient.removeQueries();
        clearSchemaCache();
        const path = window.location.pathname;
        // Already on the login flow: clearing state is enough, and navigating
        // would discard a half-entered login.
        if (path.startsWith('/auth/')) {
          // The toast only works on this branch. On the redirect below the
          // dynamic imports resolve after the document starts unloading, so
          // `?reason=expired` (rendered by `SessionExpiredNotice`) tells the
          // user instead.
          void Promise.all([import('sonner'), import('i18next')]).then(
            ([{ toast }, i18next]) =>
              toast.error(i18next.default.t('auth.session_expired_title'), {
                description: i18next.default.t('auth.session_expired_desc'),
              }),
          );
          return;
        }
        // `redirect` is the param LoginPage reads to return the user here.
        const ret = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/auth/login?reason=expired&redirect=${ret}`;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [queryClient]);

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
    // Same precedence claim as the OIDC path (see authEpochRef).
    authEpochRef.current += 1;
    setUser(response.user);
  }, []);

  const startKeycloakLogin = useCallback(
    (returnTo?: string, consentAttempt?: string): Promise<void> => {
      // Full navigation to the API, which runs the OIDC flow server-side and
      // sets the session cookie on the way back; no token passes through the
      // browser.
      startBffLogin(returnTo ?? '/', consentAttempt);
      return Promise.resolve();
    },
    []
  );

  /**
   * Called by the callback page once the API has established the session.
   * Resolving the user here keeps the context the single owner of `user`.
   */
  const completeKeycloakLogin = useCallback(async (): Promise<void> => {
    const me = meToUser(await fetchMe());
    // Claim precedence over any restore still in flight (see authEpochRef).
    authEpochRef.current += 1;
    setUser(me);
    setIsLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    if (isKeycloakLogin) {
      setUser(null);
      // Destroys the server-side session, then hands off to Keycloak so the SSO
      // session goes too. Signed out locally first, so a failure to reach
      // Keycloak still logs the user out of this app.
      const ended = await endBffSession();
      // Evict even when the logout call failed: the cookie and SSO session may
      // still be alive, but nothing of this user's stays cached on the device.
      clearSchemaCache();
      evictPerUserQueries(queryClient);
      if (!ended) {
        toast.error(t('auth.toast_signout_incomplete_title', 'Sign-out may not be complete'), {
          description: t(
            'auth.toast_signout_incomplete_desc',
            'We could not reach the server. Close this browser to be sure you are signed out.',
          ),
        });
      }
      return;
    }

    try {
      await apiSignOut();
    } finally {
      clearCsrfToken();
      setUser(null);
      clearSchemaCache();
      evictPerUserQueries(queryClient);
    }
  }, [isKeycloakLogin, queryClient, t]);

  // Memoised so consumers re-render only when the session changes; every
  // callback above is a stable reference.
  const value = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      isKeycloakLogin,
      checkUser,
      requestOtp,
      verifyOtp,
      startKeycloakLogin,
      completeKeycloakLogin,
      signOut,
    }),
    [
      user,
      isLoading,
      isKeycloakLogin,
      checkUser,
      requestOtp,
      verifyOtp,
      startKeycloakLogin,
      completeKeycloakLogin,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
