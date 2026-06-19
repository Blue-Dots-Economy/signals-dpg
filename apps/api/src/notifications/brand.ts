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
