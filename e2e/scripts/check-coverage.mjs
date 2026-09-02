#!/usr/bin/env node
/**
 * E2E traceability check — the enforcement half of the coverage rule in
 * `docs/testing/e2e-functional-test-strategy.md` §10.
 *
 * The strategy doc says: "a new API route ... that touches a P0 surface must
 * arrive with a mapped E2E test, or the traceability check fails the gate."
 * This is that check. It compares the API's **real** route table against the
 * routes the suite actually calls, and fails on anything unmapped that isn't
 * explicitly parked in `coverage-baseline.json`.
 *
 * Route table source: the repo-root `openapi.json`, which Fastify generates from
 * the live route definitions (`pnpm --filter api spec:dump`). Using the generated
 * spec rather than grepping route files means a route can't hide from the check
 * behind a plugin prefix.
 *
 * How a spec declares coverage — either is enough:
 *   1. It calls the path literally:   api.post('/api/v1/item/lifecycle', body)
 *   2. It annotates it in a comment:  // @covers POST /api/v1/item/lifecycle
 *      (needed when the path is built dynamically, or when a helper in src/
 *      does the call on the spec's behalf and you want it attributed here.)
 *
 * Usage:
 *   node scripts/check-coverage.mjs                 # report + exit 1 on regressions
 *   node scripts/check-coverage.mjs --json          # machine-readable
 *   node scripts/check-coverage.mjs --update-baseline
 *
 * No dependencies — plain Node, so it runs in CI without an npm install.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(E2E_DIR, '..');
const OPENAPI = join(REPO_ROOT, 'openapi.json');
const BASELINE = join(E2E_DIR, 'coverage-baseline.json');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Routes the gate deliberately never asserts (infra, not product surface).
 * The preflight project already proves the target is up; these add nothing.
 * Normalized below, once `op()` is defined.
 */
const IGNORED_RAW = [
  ['GET', '/'],
  ['GET', '/health/live'],
  ['GET', '/health/ready'],
];

// ---------------------------------------------------------------------------
// 1. The route table (source of truth)
// ---------------------------------------------------------------------------

/** `/api/v1/action/{action_id}/contact-details` → `/api/v1/action/{}/contact-details` */
function normalizePath(path) {
  const normalized = path
    .split('?')[0] // drop querystrings — they don't distinguish an operation
    .replace(/\$\{[^}]*\}/g, '{}') // JS template interpolation in spec code
    .replace(/\{[^}]*\}/g, '{}') // named params in the OpenAPI path
    .replace(/(.)\/+$/, '$1') // trailing slash (POST /api/v1/support/), but keep bare '/'
    .trim();
  return normalized || '/';
}

const op = (method, path) => `${method.toUpperCase()} ${normalizePath(path)}`;

const IGNORED = new Set(IGNORED_RAW.map(([method, path]) => op(method, path)));

function loadRouteTable() {
  if (!existsSync(OPENAPI)) {
    console.error(
      `\n  ✗ ${relative(REPO_ROOT, OPENAPI)} not found.\n` +
        `    Generate it first:  pnpm --filter api spec:dump\n`,
    );
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(OPENAPI, 'utf8'));
  const ops = new Map(); // normalized op -> pretty op (with real param names)
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (!item[method]) continue;
      const key = op(method, path);
      if (IGNORED.has(key)) continue;
      ops.set(key, `${method.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 2. What the suite actually exercises
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// `.post<Whatever>('/api/v1/x', body)` / `.get(`/api/v1/x?${qs}`)`
const CALL_RE = /\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\s*\(\s*(['"`])([^'"`]+)\2/g;
// `// @covers POST /api/v1/item/lifecycle`
const COVERS_RE = /@covers\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/g;

function scanSuite() {
  const found = new Map(); // normalized op -> Set(relative file)
  const record = (key, file) => {
    if (!found.has(key)) found.set(key, new Set());
    found.get(key).add(relative(E2E_DIR, file));
  };

  for (const file of [...walk(join(E2E_DIR, 'tests')), ...walk(join(E2E_DIR, 'src'))]) {
    const source = readFileSync(file, 'utf8');
    for (const [, method, , path] of source.matchAll(CALL_RE)) {
      if (!path.startsWith('/api/')) continue; // skip Mailpit/Keycloak/UI clients
      record(op(method, path), file);
    }
    for (const [, method, path] of source.matchAll(COVERS_RE)) {
      record(op(method, path), file);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 3. Baseline (known, accepted gaps — shrinks over time, never grows silently)
// ---------------------------------------------------------------------------

function loadBaseline() {
  if (!existsSync(BASELINE)) return { allowUncovered: [] };
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

function writeBaseline(uncovered, routes) {
  const payload = {
    $comment:
      'Operations the E2E suite does not yet exercise. This list is a DEBT REGISTER, not a ' +
      'permission slip: it may only shrink. Adding a line means you shipped a route without a ' +
      'journey — see docs/testing/e2e-coverage-backlog.md and .claude/rules/e2e-coverage.md. ' +
      'Regenerate with: npm run coverage:baseline',
    allowUncovered: [...uncovered].map((k) => routes.get(k) ?? k).sort(),
  };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const updating = args.includes('--update-baseline');

  const routes = loadRouteTable();
  const exercised = scanSuite();
  const baseline = loadBaseline();

  // Baseline entries are stored pretty; normalize for comparison.
  const parked = new Set(
    (baseline.allowUncovered ?? []).map((entry) => {
      const [method, ...rest] = entry.split(' ');
      return op(method, rest.join(' '));
    }),
  );

  const covered = [];
  const uncovered = [];
  for (const key of routes.keys()) (exercised.has(key) ? covered : uncovered).push(key);

  // Three failure modes, each actionable:
  const unmapped = uncovered.filter((k) => !parked.has(k)); // new route, no test  → FAIL
  const nowCovered = [...parked].filter((k) => exercised.has(k)); // test added   → tidy baseline
  const goneRoutes = [...parked].filter((k) => !routes.has(k)); // route deleted  → tidy baseline

  if (updating) {
    writeBaseline(uncovered, routes);
    console.log(`Baseline rewritten: ${uncovered.length} uncovered operation(s) parked.`);
    return;
  }

  const pct = routes.size ? Math.round((covered.length / routes.size) * 100) : 100;

  if (asJson) {
    const pretty = (k) => routes.get(k) ?? k;
    console.log(
      JSON.stringify(
        {
          total: routes.size,
          covered: covered.length,
          percent: pct,
          unmapped: unmapped.map(pretty),
          parked: [...parked].map(pretty),
          staleBaseline: [...nowCovered, ...goneRoutes].map(pretty),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nE2E route traceability — ${covered.length}/${routes.size} operations exercised (${pct}%)\n`);

    if (unmapped.length) {
      console.log(`  ✗ ${unmapped.length} route(s) with NO mapped E2E test:\n`);
      for (const key of unmapped.sort()) console.log(`      ${routes.get(key)}`);
      console.log(
        `\n    Add a journey that calls it, or annotate an existing spec with\n` +
          `      // @covers ${routes.get(unmapped[0])}\n` +
          `    See .claude/rules/e2e-coverage.md. Parking it in coverage-baseline.json\n` +
          `    is a last resort and needs a tracking issue.\n`,
      );
    }

    if (nowCovered.length) {
      console.log(`  ⚠ ${nowCovered.length} baseline entr(y/ies) are now covered — remove them:\n`);
      for (const key of nowCovered.sort()) console.log(`      ${routes.get(key) ?? key}`);
      console.log('');
    }

    if (goneRoutes.length) {
      console.log(`  ⚠ ${goneRoutes.length} baseline entr(y/ies) point at routes that no longer exist:\n`);
      for (const key of goneRoutes.sort()) console.log(`      ${key}`);
      console.log(`\n    The route was deleted — drop the baseline line and retire its test.\n`);
    }

    if (!unmapped.length && !nowCovered.length && !goneRoutes.length) {
      console.log(`  ✓ every route is either exercised or a known, parked gap.\n`);
    }
  }

  // Stale baseline is a warning, not a gate failure — only genuinely new
  // unmapped surface blocks, so the check stays trustworthy rather than noisy.
  process.exit(unmapped.length ? 1 : 0);
}

main();
