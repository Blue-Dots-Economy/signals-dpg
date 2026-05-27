/**
 * Submit synthetic Purple Dot participant registrations to Aggregator-DPG's
 * public registration link endpoint. Aggregator's worker then pushes the
 * participants to Signals-DPG via signalstack-writer.
 *
 * Usage:
 *   pnpm e2e:qr <link-slug> [count=10] [--domain seeker|provider] [--fixture <path>]
 *
 * Defaults --domain to seeker for backward compatibility.
 *
 * Env (per domain):
 *   AGGREGATOR_API_URL         e.g. https://localhost/backend
 *   SEEKER_ORG_SLUG            for --domain seeker
 *   PROVIDER_ORG_SLUG          for --domain provider
 *
 * Fixture resolution (highest precedence first):
 *   1. --fixture <path>   — explicit override (absolute or relative to cwd)
 *   2. --domain seeker    → scripts/e2e/fixtures/purple_dot_qr_payloads.json
 *   3. --domain provider  → scripts/e2e/fixtures/purple_dot_qr_provider.json
 *
 * The script rotates through fixture rows when count > fixture length.
 * Generate fresh fixtures with:
 *   pnpm tsx scripts/e2e/generate_fixtures.mts \
 *     --output-format json --domain provider --count 25 \
 *     --output scripts/e2e/fixtures/purple_dot_qr_provider.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ───────────────────────────────────────────────────────────────────────────
// Auto-load `scripts/e2e/.env` (no dotenv dep — minimal parser, existing
// process.env takes precedence so a `source ... .env` in the shell still
// wins if both are set).
// ───────────────────────────────────────────────────────────────────────────

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    if (key in process.env) continue;
    let value = m[2]!.trim();
    // Strip wrapping quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(resolve(__dirname, '.env'));

// ───────────────────────────────────────────────────────────────────────────
// Arg parsing — positional <link-slug> [count], optional --domain
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  linkSlug: string;
  count: number;
  domain: 'seeker' | 'provider';
  fixture: string | null;
} {
  const positional: string[] = [];
  let domain: 'seeker' | 'provider' = 'seeker';
  let fixture: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain') {
      const v = argv[i + 1];
      if (v !== 'seeker' && v !== 'provider') {
        die(`--domain must be 'seeker' or 'provider' (got '${v ?? ''}')`);
      }
      domain = v;
      i++;
    } else if (a === '--fixture') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        die(`--fixture requires a path`);
      }
      fixture = v;
      i++;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a?.startsWith('--')) {
      die(`unknown flag: ${a}`);
    } else {
      positional.push(a!);
    }
  }
  const linkSlug = positional[0];
  if (!linkSlug) {
    printUsage();
    process.exit(1);
  }
  const countRaw = positional[1] ?? '10';
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count <= 0) {
    die(`count must be a positive integer, got: '${countRaw}'`);
  }
  return { linkSlug, count, domain, fixture };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(1);
}

function printUsage(): void {
  console.error(
    'Usage: pnpm e2e:qr <link-slug> [count=10] [--domain seeker|provider] [--fixture <path>]',
  );
}

const { linkSlug, count, domain, fixture } = parseArgs(process.argv.slice(2));

// ───────────────────────────────────────────────────────────────────────────
// Env + fixture lookup keyed on domain (overridable via --fixture)
// ───────────────────────────────────────────────────────────────────────────

const aggApiUrl = required('AGGREGATOR_API_URL');
const orgSlugEnv = domain === 'seeker' ? 'SEEKER_ORG_SLUG' : 'PROVIDER_ORG_SLUG';
const orgSlug = required(orgSlugEnv);

// --fixture <path> takes precedence; otherwise pick the domain default.
// Paths starting with `/` are absolute; everything else is resolved
// relative to the cwd (so an operator can pass `./scratch/big.json` or
// `../shared/whatever.json` and get intuitive resolution).
const defaultFixtureFile =
  domain === 'seeker'
    ? 'fixtures/purple_dot_qr_payloads.json'
    : 'fixtures/purple_dot_qr_provider.json';
const fixturePath = fixture
  ? resolve(process.cwd(), fixture)
  : resolve(__dirname, defaultFixtureFile);

// Local dev hack: when AGGREGATOR_API_URL points at localhost, nginx
// serves with a self-signed certificate. Node's fetch rejects it by
// default. Setting NODE_TLS_REJECT_UNAUTHORIZED=0 only fires for the
// local case — production URLs go through their real cert chain.
const aggHost = (() => {
  try {
    return new URL(aggApiUrl).hostname;
  } catch {
    return '';
  }
})();
if (aggHost === 'localhost' || aggHost === '127.0.0.1' || aggHost === '::1') {
  if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn(
      `[e2e] WARN: NODE_TLS_REJECT_UNAUTHORIZED=0 for localhost target (self-signed nginx cert).`,
    );
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

let payloads: Array<Record<string, unknown>>;
try {
  payloads = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, unknown>>;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Failed to read fixture ${fixturePath}: ${msg}`);
  // Only hint at the generator when the script picked the default path —
  // a user who explicitly passed --fixture already knows where the file is.
  if (!fixture && domain === 'provider') {
    console.error(
      `Generate it via:\n` +
        `  pnpm tsx scripts/e2e/generate_fixtures.mts \\\n` +
        `    --output-format json --domain provider --count 25 \\\n` +
        `    --output scripts/e2e/fixtures/purple_dot_qr_provider.json`,
    );
  }
  process.exit(1);
}
if (payloads.length === 0) {
  console.error(`Fixture is empty: ${fixturePath}`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Submission loop
// ───────────────────────────────────────────────────────────────────────────

console.log(
  `Submitting ${count} synthetic ${domain}s to ${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`,
);
console.log(`Fixture: ${fixturePath}${fixture ? ' (override)' : ' (default)'}`);

let i = 0;
while (i < count) {
  const payload = payloads[i % payloads.length];
  const url = `${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '5');
    console.log(
      `[${(i + 1).toString().padStart(2, '0')}/${count}] 429 rate-limited; waiting ${retryAfter}s and retrying`,
    );
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    continue;
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[${(i + 1).toString().padStart(2, '0')}/${count}] HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  const result = (await res.json()) as { submission_id?: string; id?: string };
  const subId = result.submission_id ?? result.id ?? '(no id in response)';
  console.log(
    `[${(i + 1).toString().padStart(2, '0')}/${count}] POST submitted → submission_id=${subId}`,
  );
  i++;
}

console.log(`All ${count} ${domain} submissions accepted.`);
console.log('Wait ~5s for Aggregator queue to drain (signalstack-writer pushes to Signals).');
