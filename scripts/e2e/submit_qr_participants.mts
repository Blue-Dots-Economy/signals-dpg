/**
 * Submit synthetic Purple Dot seeker registrations to Aggregator-DPG's
 * public registration link endpoint. Aggregator's worker then pushes
 * the participants to Signals-DPG via signalstack-writer.
 *
 * Usage:
 *   pnpm e2e:qr <link-slug> [count=10]
 *
 * Env:
 *   AGGREGATOR_API_URL  e.g. http://localhost:4000
 *   SEEKER_ORG_SLUG     e.g. purple-dot-seekers-aggregator
 *
 * Fixture:
 *   scripts/e2e/fixtures/purple_dot_qr_payloads.json — 10 records;
 *   the script rotates through them when count > 10.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const linkSlug = process.argv[2];
const count = Number(process.argv[3] ?? 10);

if (!linkSlug) {
  console.error('Usage: pnpm e2e:qr <link-slug> [count=10]');
  process.exit(1);
}
if (!Number.isFinite(count) || count <= 0) {
  console.error(`count must be a positive integer, got: ${process.argv[3]}`);
  process.exit(1);
}

const aggApiUrl = required('AGGREGATOR_API_URL');
const orgSlug = required('SEEKER_ORG_SLUG');

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

const fixturePath = resolve(__dirname, 'fixtures/purple_dot_qr_payloads.json');
const payloads = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, unknown>>;
if (payloads.length === 0) {
  console.error(`Fixture is empty: ${fixturePath}`);
  process.exit(1);
}

console.log(`Submitting ${count} synthetic seekers to ${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`);

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
    console.log(`[${(i + 1).toString().padStart(2, '0')}/${count}] 429 rate-limited; waiting ${retryAfter}s and retrying`);
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
  console.log(`[${(i + 1).toString().padStart(2, '0')}/${count}] POST submitted → submission_id=${subId}`);
  i++;
}

console.log(`All ${count} submissions accepted.`);
console.log('Wait ~5s for Aggregator queue to drain (signalstack-writer pushes to Signals).');
