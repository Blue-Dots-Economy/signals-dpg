import { useQuery } from '@tanstack/react-query';
import { fetchSupportConfig, type SupportConfig } from '@/lib/support-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Used while the config request is in flight or after it fails. Mirrors the
 * API's defaults so the picker stays usable; the server still refuses an
 * over-limit file with a specific error.
 */
export const SUPPORT_CONFIG_FALLBACK: SupportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/*', 'video/*', 'audio/*'],
  allowedExtensions: [],
};

/**
 * Attachment limits and whether support is configured on this instance.
 * Config tier (5 min); fetched only while the dialog is open (`enabled`).
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
