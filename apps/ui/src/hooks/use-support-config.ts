import { useQuery } from '@tanstack/react-query';
import { fetchSupportConfig, type SupportConfig } from '@/lib/support-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Fallback used while the config request is in flight or if it fails (#551).
 * It mirrors the API's own defaults, so the picker is usable rather than blocked
 * — an over-limit file is still refused server-side with a specific error.
 */
export const SUPPORT_CONFIG_FALLBACK: SupportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/*', 'video/*', 'audio/*'],
  allowedExtensions: [],
};

/**
 * Attachment limits + whether support is configured on this instance.
 * Config-like data: 5 min staleTime, per `apps/ui/CLAUDE.md`'s caching tiers.
 * Only fetched while the dialog is open (`enabled`).
 */
export function useSupportConfig(enabled = true): { config: SupportConfig; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.supportConfig(),
    queryFn: fetchSupportConfig,
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  return { config: data ?? SUPPORT_CONFIG_FALLBACK, isLoading };
}
