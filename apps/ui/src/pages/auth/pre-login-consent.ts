/**
 * Whether a consent accepted on the login screen may be recorded once the user
 * is signed in. The pre-login gate reads the unauthenticated status endpoint,
 * which never reports the variant (that would disclose that an identifier
 * belongs to a minor), so it always shows the adult documents. The accept
 * endpoint stamps the variant from the stored age, so for a known minor on a
 * network with U18 documents the acceptance is dropped and the post-login gate
 * or guardian flow asks again. With no U18 set the acceptance stands. If the
 * check fails, nothing is recorded.
 */
import { fetchConsentConfigs, getConsentStatus } from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';

export async function preLoginConsentApplies(network: string, brand: string | null): Promise<boolean> {
  try {
    const [status, entries] = await Promise.all([getConsentStatus(network), fetchConsentConfigs(network)]);
    if (status.variant !== 'u18') return true;
    const networkDefault = entries.find((e) => e.brand === null);
    if (!networkDefault) return true;
    const brandEntry = brand && brand !== 'standard' ? entries.find((e) => e.brand === brand) : undefined;
    const config = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);
    return !config.u18_documents;
  } catch {
    return false;
  }
}
