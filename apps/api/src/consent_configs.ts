import { loadConsentConfigs, type LoadedConsentConfig } from '@dpg/config';
import { apiConfig } from '@/config';

let consentConfigsPromise: Promise<LoadedConsentConfig[]> | null = null;

function loadAll(): Promise<LoadedConsentConfig[]> {
  const networks = [
    ...new Set(apiConfig.served_domains.map((binding) => binding.network)),
  ];
  return loadConsentConfigs({
    source: apiConfig.consent_config_source,
    networkLocalFile: apiConfig.network_config_local_file,
    networks,
    supportEmail: apiConfig.consent_support_email,
  });
}

export async function getConsentConfigs(): Promise<LoadedConsentConfig[]> {
  if (!consentConfigsPromise) {
    consentConfigsPromise = loadAll();
  }
  return consentConfigsPromise;
}

export async function refreshConsentConfigs(): Promise<LoadedConsentConfig[]> {
  consentConfigsPromise = loadAll();
  return consentConfigsPromise;
}
