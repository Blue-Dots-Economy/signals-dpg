/**
 * Inverts the deployment's host-binding string (domain -> portal origin) so an
 * email can send a recipient to their own portal. The UI ingress reads the same
 * string the other way (host -> network/domain), so the two cannot disagree.
 *
 * Format (identical to `ui.hostBindings`):
 *   host=network/domain;host=network/domain
 *
 * A host with an explicit `http://` / `https://` scheme and port is used
 * verbatim (for local split-UI stacks); a bare hostname gets `https://`.
 *
 * Never throws: a malformed entry is dropped with a warning so one typo cannot
 * take the API down. Warnings are returned, not logged, because this runs at
 * module load before a logger exists.
 */

const BINDING_REGEX = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

export interface ParsedUiHostBindings {
  /** Item domain (e.g. "seeker") -> portal origin (e.g. "https://x.org"). */
  byDomain: Record<string, string>;
  /** One message per skipped or ambiguous entry. */
  warnings: string[];
}

/**
 * Strips one layer of quotes plus surrounding whitespace: a ConfigMap value
 * rendered through Helm `| quote` arrives with the quotes attached.
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
      // First wins, so a vanity alias listed after the canonical host cannot
      // displace it.
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
 * Parsed keys that name no domain this instance serves. Used for logging only:
 * filtering them out would let a network.json and ConfigMap rollout skew switch
 * a working link off.
 */
export function unknownBindingDomains(
  byDomain: Record<string, string>,
  knownDomains: readonly string[]
): string[] {
  const known = new Set(knownDomains);
  return Object.keys(byDomain).filter((domain) => !known.has(domain));
}
