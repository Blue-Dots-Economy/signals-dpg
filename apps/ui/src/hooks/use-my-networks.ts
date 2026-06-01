import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createApiClient } from '@/lib/api-client';
import { useAuth } from '@/contexts/auth-context';

export interface MyMembership {
  network: string;
  domain: string;
}

interface JoinResponse {
  network: string;
  domain: string;
  created: boolean;
}

const apiClient = createApiClient();

function parseBinding(binding: string): MyMembership | null {
  const idx = binding.indexOf('/');
  if (idx <= 0 || idx === binding.length - 1) return null;
  return { network: binding.slice(0, idx), domain: binding.slice(idx + 1) };
}

/**
 * Returns the current user's (network, domain) memberships parsed from
 * user.domains carried on the session. No separate fetch — the auth
 * context already loads the user row from /api/auth/get-session.
 */
export function useMyNetworks(_enabled: boolean = true) {
  const { user, isLoading } = useAuth();
  const data = useMemo<MyMembership[] | undefined>(() => {
    if (!user) return undefined;
    return (user.domains ?? [])
      .map(parseBinding)
      .filter((m): m is MyMembership => m !== null);
  }, [user]);
  return { data, isLoading };
}

/**
 * Append (network, domain) to current user's domains[] via POST
 * /api/v1/me/domains. 409 if user already holds a different domain in
 * this network. Refreshes the session afterwards so useMyNetworks sees
 * the new entry without a manual refetch.
 */
export function useJoinNetwork() {
  const { refreshSession } = useAuth();
  return useMutation({
    mutationFn: async (input: { network: string; domain: string }) => {
      const res = await apiClient.post<JoinResponse>(
        '/api/auth/unified-otp/join-network',
        input,
      );
      return res.data;
    },
    onSuccess: async () => {
      await refreshSession();
    },
  });
}
