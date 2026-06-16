import { getRuntimeEnv } from '@/lib/runtime-env';

export interface ServedBinding {
  network: string;
  domain: string;
}

/**
 * Parses a "<network>/<domain>" binding string (e.g. "purple_dot/provider").
 * Returns null for unset / blank / malformed input (missing half, extra slash).
 * Pure — exported separately so it can be unit-tested without runtime config.
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
 * The network/domain this UI instance is scoped to, from the runtime config
 * key VITE_SERVED_BINDING. Null when unset/malformed — the UI then runs in its
 * legacy multi-domain mode (domain derived from the logged-in user's profile).
 */
export function getServedBinding(): ServedBinding | null {
  return parseServedBinding(getRuntimeEnv('VITE_SERVED_BINDING'));
}
