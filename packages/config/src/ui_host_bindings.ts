/**
 * Inverts the deployment's host-binding string into the map the API needs to
 * send a recipient to their OWN portal.
 *
 * The same string drives the UI ingress in the other direction — it derives
 * `VITE_SERVED_BINDINGS` (host -> network/domain) from the request's Host
 * header. Here we derive domain -> origin. One value, two directions, so the
 * two cannot drift into disagreeing about which host serves which domain.
 *
 * Format (identical to `ui.hostBindings`):
 *   host=network/domain;host=network/domain
 *
 * The host MAY carry an explicit `http://` / `https://` scheme and a port, in
 * which case it is used verbatim; a bare hostname gets `https://`. Deployed
 * strings are bare FQDNs; the scheme form exists so a local split-UI stack can
 * point at `http://localhost:5174`.
 *
 * Never throws. One typo must not take the API down over an optional feature,
 * so a malformed entry is dropped with a warning. Warnings are RETURNED rather
 * than logged because this runs at module load, before a logger exists — the
 * caller logs them once Fastify is up.
 */

const BINDING_REGEX = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

export interface ParsedUiHostBindings {
  /** Item domain (e.g. "seeker") -> portal origin (e.g. "https://x.org"). */
  byDomain: Record<string, string>;
  /** One message per skipped or ambiguous entry. */
  warnings: string[];
}

/**
 * Strips a single layer of Helm `| quote`-style wrapping plus surrounding
 * whitespace. A ConfigMap value round-tripped through `| quote` arrives with
 * the quotes still attached.
 */
function stripHelmQuoting(raw: string): string {
  const v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** Normalize the host half of an entry into an origin, or null if unusable. */
function toOrigin(host: string): string | null {
  if (!host) return null;
  if (/^https?:\/\//.test(host)) {
    try {
      return new URL(host).origin;
    } catch {
      return null;
    }
  }
  // A bare hostname must not carry a path or whitespace.
  if (host.includes('/') || /\s/.test(host)) return null;
  return `https://${host}`;
}

export function parseUiHostBindings(raw: string | undefined): ParsedUiHostBindings {
  const byDomain: Record<string, string> = {};
  const warnings: string[] = [];

  for (const rawEntry of stripHelmQuoting(raw ?? '').split(/[;\n]/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    // First `=` only: the host half may itself be a URL containing `=`.
    const eq = entry.indexOf('=');
    if (eq === -1) {
      warnings.push(`UI_HOST_BINDINGS: skipping entry with no "=" separator: "${entry}"`);
      continue;
    }

    const host = entry.slice(0, eq).trim();
    const binding = entry.slice(eq + 1).trim();

    const origin = toOrigin(host);
    if (!origin) {
      warnings.push(`UI_HOST_BINDINGS: skipping entry with an invalid host: "${entry}"`);
      continue;
    }
    if (!BINDING_REGEX.test(binding)) {
      warnings.push(
        `UI_HOST_BINDINGS: skipping entry with invalid "network/domain" binding: "${entry}"`
      );
      continue;
    }

    const domain = binding.split('/')[1];
    if (Object.hasOwn(byDomain, domain)) {
      // FIRST wins, not last: a vanity alias listed after the canonical host
      // must not silently displace it.
      warnings.push(
        `UI_HOST_BINDINGS: duplicate entry for domain "${domain}" — the first one wins`
      );
      continue;
    }
    byDomain[domain] = origin;
  }

  return { byDomain, warnings };
}

/**
 * Which parsed keys name no domain this instance serves.
 *
 * Log-only by design. Filtering unknown keys would be wrong: a domain added to
 * `network.json` ahead of the ConfigMap rollout (or vice versa) must not be
 * able to switch a working link off.
 */
export function unknownBindingDomains(
  byDomain: Record<string, string>,
  knownDomains: readonly string[]
): string[] {
  const known = new Set(knownDomains);
  return Object.keys(byDomain).filter((domain) => !known.has(domain));
}
