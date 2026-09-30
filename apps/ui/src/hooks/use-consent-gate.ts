import { useQuery } from '@tanstack/react-query';
import type { ConsentConfigDocument } from '@dpg/schemas';
import { getConsentStatus } from '@/lib/consent-api';
import {
  currentGateVersions,
  outstandingGateCategories,
  type ConsentVariant,
} from '@/lib/consent-gate';
import { useConsentConfig } from './use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';

type ConsentCategory = 'terms' | 'privacy';

interface CurrentVersions {
  terms: number;
  privacy: number;
}

interface UseConsentGateResult {
  needed: ConsentCategory[];
  config: ConsentConfigDocument | null;
  currentVersions: CurrentVersions | null;
  /**
   * Which document set applies (#626). Comes from the status endpoint, which
   * derives it server-side from the user's recorded age — the client has no
   * access to the age and must not decide this for itself.
   */
  variant: ConsentVariant;
  isLoading: boolean;
  refetch: () => void;
}

export function useConsentGate(): UseConsentGateResult {
  const { themeId } = useNetworkTheme();
  const { config, isLoading: configLoading } = useConsentConfig();

  const {
    data: status,
    isLoading: statusLoading,
    refetch,
  } = useQuery({
    queryKey: ['consent-status', themeId],
    queryFn: () => getConsentStatus(themeId),
    enabled: !!themeId,
    staleTime: 0,
  });

  const isLoading = configLoading || statusLoading;

  if (!config || !status) {
    return {
      needed: [],
      config,
      currentVersions: null,
      variant: 'adult',
      isLoading,
      refetch,
    };
  }

  const variant: ConsentVariant = status.variant ?? 'adult';
  const currentVersions: CurrentVersions = currentGateVersions(config, variant);
  const needed: ConsentCategory[] = outstandingGateCategories(config, variant, status.statuses);

  return {
    needed,
    variant,
    config,
    currentVersions,
    isLoading,
    refetch,
  };
}
