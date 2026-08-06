import { useQuery } from '@tanstack/react-query';
import type { ConsentConfigDocument } from '@dpg/schemas';
import { fetchConsentConfigs } from '@/lib/consent-api';
import { useNetworkTheme } from '@/theme/theme-provider';
import { queryKeys } from '@/lib/query-keys';

export function mergeConsentConfig(
  networkDefault: ConsentConfigDocument,
  brandOverride?: ConsentConfigDocument,
): ConsentConfigDocument {
  if (!brandOverride) return networkDefault;

  return {
    documents: {
      terms: brandOverride.documents.terms ?? networkDefault.documents.terms,
      privacy: brandOverride.documents.privacy ?? networkDefault.documents.privacy,
      profile_creation:
        brandOverride.documents.profile_creation ?? networkDefault.documents.profile_creation,
    },
    actions: brandOverride.actions ?? networkDefault.actions,
  };
}

interface UseConsentConfigResult {
  config: ConsentConfigDocument | null;
  isLoading: boolean;
}

export function useConsentConfig(): UseConsentConfigResult {
  const { themeId, brand } = useNetworkTheme();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.consentConfig(themeId, brand),
    queryFn: async () => {
      const entries = await fetchConsentConfigs(themeId);
      const networkDefault = entries.find((e) => e.brand === null);
      if (!networkDefault) return null;
      const brandEntry = brand ? entries.find((e) => e.brand === brand) : undefined;
      return mergeConsentConfig(networkDefault.schema, brandEntry?.schema);
    },
    staleTime: 5 * 60 * 1000,
  });

  return {
    config: data ?? null,
    isLoading,
  };
}
