/**
 * The instance's auth config (`GET /api/v1/auth/config`), fetched once and
 * shared app-wide via React Query.
 *
 * This is what makes the login provider a runtime decision instead of something
 * compiled into the bundle: the login screen, the OIDC connection details and
 * the self-signup / channel flags all come from the server, so flipping
 * providers needs no rebuild and the UI cannot disagree with the API.
 *
 * The response is treated as effectively static for the session — it only
 * changes when the API is redeployed with different env — so it is cached
 * rather than refetched on every mount or window focus.
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
    // One retry: if the API is briefly unreachable we fall back to the OTP
    // screens, which is the safe default — never strand the user on a Keycloak
    // redirect the server never asked for.
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
