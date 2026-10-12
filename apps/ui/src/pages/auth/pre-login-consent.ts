/**
 * Whether a consent accepted on the login screen may be recorded, now that the
 * user is signed in (#626).
 *
 * The pre-login gate reads the UNAUTHENTICATED status endpoint, which never
 * reports the variant (it would disclose that a phone number belongs to a
 * minor), so it always shows the ADULT documents. The accept endpoint then
 * stamps the variant from the stored age. For a known minor on a network that
 * ships a U18 set, writing that acceptance would record `u18` against a person
 * who read the adult text — so it is dropped instead, and the post-login gate
 * (or the guardian flow) asks again with the U18 documents.
 *
 * On a network with no U18 set the adult documents ARE the minor's documents,
 * so the acceptance stands. If the check itself fails, nothing is recorded:
 * the user is re-prompted next time rather than recorded against copy that may
 * not have been theirs.
 *
 * @module pages/auth/pre-login-consent
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
