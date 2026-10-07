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
    // Per-document, like `documents` above: a brand that overrides only the U18
    // terms keeps the network's U18 privacy rather than losing the whole set.
    // Dropping `u18_documents` here (as this did) silently downgraded every
    // branded deployment's minors to the adult copy (#626).
    u18_documents: mergeU18Documents(networkDefault.u18_documents, brandOverride.u18_documents),
    actions: brandOverride.actions ?? networkDefault.actions,
  };
}

function mergeU18Documents(
  base: ConsentConfigDocument['u18_documents'],
  override: ConsentConfigDocument['u18_documents'],
): ConsentConfigDocument['u18_documents'] {
  if (!base) return override;
  if (!override) return base;
  return {
    terms: override.terms ?? base.terms,
    privacy: override.privacy ?? base.privacy,
    profile_creation: override.profile_creation ?? base.profile_creation,
    guardian_declaration: override.guardian_declaration ?? base.guardian_declaration,
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
