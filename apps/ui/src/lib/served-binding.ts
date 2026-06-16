import { getRuntimeEnv } from '@/lib/runtime-env';

export interface ServedBinding {
  network: string;
  domain: string;
}

/**
 * The set of domains a UI deployment serves, all within one network. Parsed
 * from a comma-separated VITE_SERVED_BINDINGS list. A single entry yields a
 * one-domain scope (the single-domain portal); multiple entries yield a
 * whitelisted multi-domain UI; unset yields null (serve all domains).
 */
export interface ServedScope {
  network: string;
  domains: string[];
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
 * Parses a comma-separated list of "<network>/<domain>" bindings into a single
 * served scope. All entries must share the same network. Returns null when
 * unset / blank / any entry malformed / entries span multiple networks — in
 * which case the UI serves all domains (combined mode).
 * Pure — exported separately for unit testing without runtime config.
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

/**
 * The network/domain set this UI instance is scoped to, from the runtime
 * config key VITE_SERVED_BINDINGS. Null when unset/malformed — the UI then
 * runs in its combined multi-domain mode (serves all domains).
 */
export function getServedScope(): ServedScope | null {
  return parseServedScope(getRuntimeEnv('VITE_SERVED_BINDINGS'));
}
