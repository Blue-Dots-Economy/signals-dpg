import { getRuntimeEnv } from '@/lib/runtime-env';

export interface ServedBinding {
  network: string;
  domain: string;
}

/**
 * The domains a UI deployment serves, all within one network, from the
 * comma-separated `VITE_SERVED_BINDINGS`. One entry is a single-domain portal,
 * several a multi-domain portal; unset means serve all domains.
 */
export interface ServedScope {
  network: string;
  domains: string[];
}

/**
 * Parses a "<network>/<domain>" binding (e.g. "purple_dot/provider"). Returns
 * null for unset, blank or malformed input.
 */
export function parseServedBinding(raw: string | null | undefined): ServedBinding | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const network = trimmed.slice(0, slash).trim();
  const domain = trimmed.slice(slash + 1).trim();
  if (!network || !domain || domain.includes('/')) return null;
  return { network, domain };
}

/**
 * Parses a comma-separated list of "<network>/<domain>" bindings into one
 * served scope. Returns null (serve all domains) when unset, blank, any entry
 * is malformed, or entries span more than one network.
 */
export function parseServedScope(raw: string | null | undefined): ServedScope | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const bindings = parts.map(parseServedBinding);
  if (bindings.some((b) => b === null)) return null;
  const valid = bindings as ServedBinding[];
  const network = valid[0].network;
  if (valid.some((b) => b.network !== network)) return null;
  const domains = Array.from(new Set(valid.map((b) => b.domain)));
  return { network, domains };
}

/** The runtime-configured served scope; null means serve all domains. */
export function getServedScope(): ServedScope | null {
  return parseServedScope(getRuntimeEnv('VITE_SERVED_BINDINGS'));
}
