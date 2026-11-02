/**
 * The instance's auth config (`GET /api/v1/auth/config`), fetched once and
 * shared app-wide. The login screen, OIDC connection details and self-signup /
 * channel flags come from the server, so the UI cannot disagree with the API.
 * It changes only on an API redeploy, so it is cached for the session.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchAuthConfig, type AuthConfigResponse } from '@/lib/auth-api';
import { isKeycloakLoginEnabled, resolveUiAuthProvider } from '@/lib/keycloak-config';

export const AUTH_CONFIG_QUERY_KEY = ['auth-config'] as const;

export interface UseAuthConfigResult {
  config: AuthConfigResponse | undefined;
  isLoading: boolean;
  /** Render the Keycloak login screen rather than the OTP screens. */
  isKeycloakLogin: boolean;
}

export function useAuthConfig(): UseAuthConfigResult {
  const { data, isLoading } = useQuery({
    queryKey: AUTH_CONFIG_QUERY_KEY,
    queryFn: fetchAuthConfig,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // No retry when another consumer mounts an errored query (staleTime only
    // protects a query with data). Otherwise the LoginPage wrapper and the
    // screen it mounts flap forever on a config failure: each mount retries,
    // flips the query to pending, and swaps the screen back to the spinner.
    retryOnMount: false,
    // If the config still fails, `isKeycloakLogin` is false and the legacy OTP
    // screen renders; the API no longer serves its `/api/auth/*` endpoints.
    retry: 1,
  });

  return {
    config: data,
    isLoading,
    isKeycloakLogin: isKeycloakLoginEnabled(data),
  };
}

/** The resolved provider without the "is it usable" check. For diagnostics. */
export function useUiAuthProvider(): ReturnType<typeof resolveUiAuthProvider> {
  const { config } = useAuthConfig();
  return resolveUiAuthProvider(config);
}
