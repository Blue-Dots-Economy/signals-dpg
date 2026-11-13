import type { TFunction } from 'i18next';

/**
 * The message shown when Confirm is pressed before the request's network
 * config is ready: still loading, or failed to load.
 */
export function updaterConfigMessage(
  attempted: boolean,
  configReady: boolean,
  configFailed: boolean,
  t: TFunction,
): string | undefined {
  if (!attempted || configReady) return undefined;
  return configFailed
    ? t('actions.updater_config_error', "Couldn't load the details for this request. Check your connection, then close and try again.")
    : t('actions.updater_config_loading', 'Still loading. Please try again in a moment.');
}
