/**
 * Brand / URL resolution for action emails. Pure helpers — the dispatcher
 * supplies the values from network config + env (the same sources OTP reads).
 */

/** Generic Phase-1 CTA: the frontend base URL + the UI login route. */
export function buildCtaUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/auth/login`;
}

/**
 * Brand display name for the sign-off: the network display name when set,
 * otherwise the instance name (matches the OTP path).
 */
export function resolveBrandName(opts: {
  networkDisplayName?: string;
  instanceName: string;
}): string {
  const display = opts.networkDisplayName?.trim();
  return display ? display : opts.instanceName;
}

/**
 * Per-network CTA button colour for action emails. Emails can't use CSS
 * variables, so the colour is inlined per-send. Keyed by network id; unknown
 * networks fall back to the neutral blue. (Phase-2 NS-owned templates can move
 * this into per-network config.)
 */
const BRAND_COLOR: Record<string, string> = {
  blue_dot: '#2563eb',
  purple_dot: '#7c3aed',
  yellow_dot: '#d97706',
  onest_yellow_dot: '#d97706',
  pink_dot: '#db2777',
  green_dot: '#16a34a',
  orange_dot: '#ea580c',
};

export const DEFAULT_BRAND_COLOR = '#2563eb';

export function resolveBrandColor(networkId: string | null | undefined): string {
  if (!networkId) return DEFAULT_BRAND_COLOR;
  return BRAND_COLOR[networkId] ?? DEFAULT_BRAND_COLOR;
}
