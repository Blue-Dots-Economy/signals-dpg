/**
 * Partner-portal Apply redirect (SSO_NCS_APPLY_URL_TEMPLATE on the API): a
 * signed-in seeker's Apply opens the partner's page in a new tab, the
 * template's `{field}` filled from the provider profile. A provider without
 * that field keeps the in-app flow.
 */

import * as React from 'react';
import { useAuthConfig } from '@/hooks/use-auth-config';
import type { ExternalApplyConfig } from '@/lib/auth-api';

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/;

/** The partner URL, or null when the action stays in-app. The value is URI-encoded. */
export function buildExternalApplyUrl(
  config: ExternalApplyConfig | null | undefined,
  actionType: string,
  itemState: Record<string, unknown> | null | undefined
): string | null {
  if (!config || config.actionType !== actionType || !itemState) return null;
  const match = PLACEHOLDER.exec(config.urlTemplate);
  if (!match) return null;

  const raw = itemState[match[1]];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  if (!value) return null;

  const url = config.urlTemplate.replace(PLACEHOLDER, encodeURIComponent(value));
  return url.startsWith('https://') ? url : null;
}

/** New tab with no opener/referrer. Call inside the click handler (popup blockers). */
export function openExternalApply(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** `(actionType, itemState) => url | null`; signed out always null (sign-in prompt stays). */
export function useExternalApply(
  signedIn: boolean
): (actionType: string, itemState: Record<string, unknown> | null | undefined) => string | null {
  const { config } = useAuthConfig();
  const externalApply = config?.externalApply ?? null;
  return React.useCallback(
    (actionType, itemState) =>
      signedIn ? buildExternalApplyUrl(externalApply, actionType, itemState) : null,
    [signedIn, externalApply]
  );
}
