import { useQuery } from '@tanstack/react-query';
import type { ConsentConfigDocument } from '@dpg/schemas';
import { getConsentStatus } from '@/lib/consent-api';
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
      isLoading,
      refetch,
    };
  }

  const currentVersions: CurrentVersions = {
    terms: config.documents.terms.current_version,
    privacy: config.documents.privacy.current_version,
  };

  const needed = (['terms', 'privacy'] as const).filter(
    (c) => !status.statuses[c].includes(currentVersions[c]),
  );

  return {
    needed,
    config,
    currentVersions,
    isLoading,
    refetch,
  };
}
