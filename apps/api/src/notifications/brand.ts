/** Brand and URL helpers for notification emails. */

/** The UI login route under `baseUrl`. */
export function buildCtaUrl(baseUrl: string): string {
  // A loop, not /\/+$/, which backtracks quadratically on long slash runs.
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/auth/login`;
}

/** Sign-off brand name: the network display name when set, else the instance name. */
export function resolveBrandName(opts: {
  networkDisplayName?: string;
  instanceName: string;
}): string {
  const display = opts.networkDisplayName?.trim();
  return display ? display : opts.instanceName;
}

/** Per-network CTA button colour, inlined because emails cannot use CSS variables. */
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

/**
 * Builds a resolver from the recipient's domain to its portal's login URL, or
 * undefined when nothing is configured. `byDomain` is `{}` on a single-host
 * install.
 *
 * A domain missing from `byDomain` falls back to `FRONTEND_BASE_URL`, which on
 * a split deployment is a blocked host; that is preferred over sending no
 * email. The boot-time unknown-domain warning flags the missing mapping.
 */
export function createCtaUrlResolver(opts: {
  byDomain: Record<string, string>;
  fallbackBaseUrl?: string;
}): (domain: string) => string | undefined {
  const { byDomain, fallbackBaseUrl } = opts;
  return (domain: string) => {
    const origin = byDomain[domain] ?? fallbackBaseUrl;
    return origin ? buildCtaUrl(origin) : undefined;
  };
}
