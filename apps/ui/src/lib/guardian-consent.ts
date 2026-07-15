import type { DotNetworkSchema } from '@/engine/types';

/**
 * Whether a served domain routes minors through the U18 guardian consent flow
 * (Phase 6). Mirrors the server-side check in apps/api/src/services/minor.ts —
 * the server remains authoritative; this only decides which UI to render.
 */
export function isGuardianConsentRequiredDomain(
  network: DotNetworkSchema,
  domainId: string,
): boolean {
  return network.domains.find((d) => d.id === domainId)?.guardian_consent_required ?? false;
}
