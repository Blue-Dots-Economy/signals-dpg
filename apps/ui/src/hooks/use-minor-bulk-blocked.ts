import { useQuery } from '@tanstack/react-query';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { getU18Status } from '@/lib/consent-api';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { queryKeys } from '@/lib/query-keys';
import type { DotNetworkSchema } from '@/engine/types';

/**
 * True when this user is a minor on a guardian-gated domain, their guardian
 * gets OTPs by SMS, and the instance has bulk turned off for minors (#917):
 * the UI then asks them to act one request at a time instead of sending the
 * batch. The API refuses it anyway. An email guardian keeps bulk.
 */
export function useMinorBulkBlocked(
  network: DotNetworkSchema | null | undefined,
  domainId: string | null | undefined,
): boolean {
  const { config } = useAuthConfig();
  const bulkOff = config?.minorBulkActionsEnabled === false;
  const gated = !!network && !!domainId && isGuardianConsentRequiredDomain(network, domainId);
  const networkId = network?.id ?? '';
  const { data } = useQuery({
    queryKey: queryKeys.u18Status(networkId),
    queryFn: () => getU18Status(networkId),
    enabled: bulkOff && gated,
    staleTime: 60_000,
  });
  return bulkOff && gated && data?.isMinor === true && data.guardianContactType === 'phone';
}
