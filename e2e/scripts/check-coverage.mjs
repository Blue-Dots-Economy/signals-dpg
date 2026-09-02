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
 * ROUTES ARE ONLY ONE AXIS. `docs/testing/e2e-drift-audit-2026-09-02.md` §4
 * records the moment this gate read 33/53 route operations (62%) while the
 * entire notification subsystem, the shareable-profile page and My Actions
 * filtering had zero coverage — none of those is a route the check above can
 * see, so it was green about them by construction. `enumerateFeatures()`
 * below reads four more axes straight out of the code (UI routes, email
 * cases, SMS cases, `x-*` schema markers) and diffs each against
 * `.claude/skills/signals-e2e/coverage.md` — a feature is "mapped" once its
 * exact name is named there (backtick-quoted, matching that file's own
 * convention) or annotated in a spec with `// @covers <AXIS> <name>` (AXIS is
 * one of ROUTE/EMAIL/SMS/SCHEMA; UI routes ALSO count as mapped when a spec
 * navigates to them literally, the same call-site detection the API routes
 * above use). Anything named nowhere and not parked in
 * `coverage-baseline.json`'s `allowUncoveredFeatures` fails the gate, by name.
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
import { createRequire } from 'node:module';

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
// 2b. Feature enumeration — the four axes beyond routes.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

const COVERAGE_MD = join(REPO_ROOT, '.claude/skills/signals-e2e/coverage.md');

const AXES = ['uiRoutes', 'emailCases', 'smsCases', 'schemaMarkers'];
const AXIS_LABEL = {
  uiRoutes: 'UI route',
  emailCases: 'email case',
  smsCases: 'SMS case',
  schemaMarkers: 'schema marker',
};

/** `<Route path="/legal" .../>` → `/legal` */
function uiRoutesFrom(repoRoot) {
  const text = readFileSync(join(repoRoot, 'apps/ui/src/app.tsx'), 'utf8');
  const routes = new Set();
  for (const [, , path] of text.matchAll(/path=(["'])([^"']+)\1/g)) routes.add(path);
  return [...routes].sort();
}

/**
 * Every registered email case id, read from the live registry module rather
 * than grepped. 16 of the currently-39 ids are generated by a nested loop
 * over ACTION_GROUPS × ACTION_ROLES × ACTION_SHAPES in email_cases.ts and
 * never appear there as a literal string — a `CASES.set(` scrape silently
 * misses all 16. `require()`ing the module executes that loop and reads back
 * its real output; Node's built-in type-stripping handles the `.ts` file
 * directly (it has no syntax that needs an actual transform), and `require`
 * — not `import()` — because `enumerateFeatures` must stay synchronous to
 * match its call sites (see check-coverage.test.mjs).
 */
function emailCasesFrom(repoRoot) {
  const mod = require(join(repoRoot, 'apps/api/src/notifications/email/email_cases.ts'));
  return [...mod.EMAIL_CASE_IDS].sort();
}

/** Every `<id>.template_id` key in sms.default.properties, via the API's own
 * tiny properties parser (not a bespoke regex) so this can't drift from what
 * dispatch_sms.ts actually reads. */
function smsCasesFrom(repoRoot) {
  const { parseProperties } = require(
    join(repoRoot, 'apps/api/src/notifications/email/parse_properties.ts'),
  );
  const text = readFileSync(join(repoRoot, 'apps/api/src/notifications/sms/sms.default.properties'), 'utf8');
  const { entries } = parseProperties(text);
  const ids = new Set();
  for (const key of entries.keys()) {
    if (key.endsWith('.template_id')) ids.add(key.slice(0, -'.template_id'.length));
  }
  return [...ids].sort();
}

/** Every distinct `"x-…"` key actually IN USE across the shipped network
 * schemas — a marker the code supports but no network has adopted yet (e.g.
 * `x-uri`, `x-error-message` as of this writing) is not a product surface to
 * gate on. */
function schemaMarkersFrom(repoRoot) {
  const dir = join(repoRoot, 'examples/schemas');
  const markers = new Set();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const networkFile = join(dir, entry, 'network.json');
      if (!existsSync(networkFile)) continue;
      const text = readFileSync(networkFile, 'utf8');
      for (const [, marker] of text.matchAll(/"(x-[A-Za-z0-9_-]+)"\s*:/g)) markers.add(marker);
    }
  }
  return [...markers].sort();
}

/**
 * Reads four more coverage axes straight out of the code (see the module doc
 * comment for why this exists). Synchronous and side-effect-free: it does
 * not itself decide what counts as "covered" — `diffFeatures` below does.
 */
export function enumerateFeatures(repoRoot) {
  const root = resolve(repoRoot);
  return {
    uiRoutes: uiRoutesFrom(root),
    emailCases: emailCasesFrom(root),
    smsCases: smsCasesFrom(root),
    schemaMarkers: schemaMarkersFrom(root),
  };
}

// `gotoEn(page, '/profile/new')` / `page.goto('/auth/login')` — the same
// call-site detection the API routes get above, since a UI route (unlike an
// email/SMS case or a schema marker) genuinely IS a literal string a spec
// navigates to.
const UI_NAV_RE = /(?:gotoEn\s*\(\s*page\s*,|page\.goto\()\s*(['"`])([^'"`]+)\1/g;

// `// @covers ROUTE /legal`, `// @covers EMAIL support.request`,
// `// @covers SMS account.aggregator_init`, `// @covers SCHEMA x-uri` — the
// feature-axis sibling of the route COVERS_RE above, for a case fired
// through a helper, or a marker exercised without ever appearing as a
// literal string the scanners below could find.
const FEATURE_COVERS_RE = /@covers\s+(ROUTE|EMAIL|SMS|SCHEMA)\s+(\S+)/g;
const FEATURE_COVERS_AXIS = { ROUTE: 'uiRoutes', EMAIL: 'emailCases', SMS: 'smsCases', SCHEMA: 'schemaMarkers' };

function scanFeatureCallSitesAndAnnotations() {
  const named = { uiRoutes: new Set(), emailCases: new Set(), smsCases: new Set(), schemaMarkers: new Set() };
  for (const file of [...walk(join(E2E_DIR, 'tests')), ...walk(join(E2E_DIR, 'src'))]) {
    const source = readFileSync(file, 'utf8');
    for (const [, , path] of source.matchAll(UI_NAV_RE)) named.uiRoutes.add(path);
    for (const [, axis, name] of source.matchAll(FEATURE_COVERS_RE)) named[FEATURE_COVERS_AXIS[axis]].add(name);
  }
  return named;
}

function loadCoverageMdText() {
  return existsSync(COVERAGE_MD) ? readFileSync(COVERAGE_MD, 'utf8') : '';
}

/**
 * `.claude/skills/signals-e2e/coverage.md` names a feature by wrapping it in
 * backticks — its own convention (`` `/legal` ``, `` `x-uri` ``,
 * `` `match-score/calculate` ``). Backtick-bounded rather than a bare
 * substring match, or a one-character route like "/" would be "named" by
 * every unrelated code span in the file.
 */
function namedInCoverageMd(name, text) {
  return text.includes(`\`${name}\``);
}

/**
 * Diffs each enumerated feature against the two places a human could have
 * named it (`coverage.md`, an `@covers` annotation — plus literal UI
 * navigation for the uiRoutes axis) and against the `allowUncoveredFeatures`
 * debt register. Mirrors the route diff in `main()`: `uncovered` is every
 * name mapped nowhere (the true current gap, regardless of the baseline —
 * what `--update-baseline` writes); `unmapped` is the subset NOT already
 * parked (what fails the gate); `nowMapped`/`gone` are stale-baseline
 * warnings, same as the route check's `nowCovered`/`goneRoutes`.
 */
function diffFeatures(enumerated, baseline) {
  const coverageMdText = loadCoverageMdText();
  const named = scanFeatureCallSitesAndAnnotations();
  const parkedAll = baseline.allowUncoveredFeatures ?? {};

  const result = {};
  for (const axis of AXES) {
    const names = enumerated[axis];
    const parkedSet = new Set(parkedAll[axis] ?? []);
    const uncovered = names.filter((n) => !namedInCoverageMd(n, coverageMdText) && !named[axis].has(n));
    const mappedCount = names.length - uncovered.length;
    result[axis] = {
      total: names.length,
      mapped: mappedCount,
      uncovered, // full current gap — feeds --update-baseline
      unmapped: uncovered.filter((n) => !parkedSet.has(n)), // gap NOT parked — fails the gate
      nowMapped: [...parkedSet].filter((n) => names.includes(n) && !uncovered.includes(n)), // baseline stale: now named
      gone: [...parkedSet].filter((n) => !names.includes(n)), // baseline stale: feature removed/renamed
      parked: [...parkedSet],
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3. Baseline (known, accepted gaps — shrinks over time, never grows silently)
// ---------------------------------------------------------------------------

function loadBaseline() {
  if (!existsSync(BASELINE)) return { allowUncovered: [], allowUncoveredFeatures: {} };
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

function writeBaseline(uncovered, routes, featureDiff) {
  const payload = {
    $comment:
      'Operations the E2E suite does not yet exercise. This list is a DEBT REGISTER, not a ' +
      'permission slip: it may only shrink. Adding a line means you shipped a route without a ' +
      'journey — see docs/testing/e2e-coverage-backlog.md and .claude/rules/e2e-coverage.md. ' +
      'Regenerate with: npm run coverage:baseline',
    allowUncovered: [...uncovered].map((k) => routes.get(k) ?? k).sort(),
    $featuresComment:
      'UI routes / email cases / SMS cases / x-* schema markers named nowhere the gate can see ' +
      '(neither coverage.md nor an @covers annotation). Same discipline as allowUncovered above: ' +
      'a DEBT REGISTER, not a permission slip — it may only shrink. This is audit §3\'s backlog ' +
      '(docs/testing/e2e-drift-audit-2026-09-02.md) — it starts full and burns down as Plan 2 adds ' +
      'coverage. Regenerate with: npm run coverage:baseline',
    allowUncoveredFeatures: Object.fromEntries(AXES.map((axis) => [axis, [...featureDiff[axis].uncovered].sort()])),
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

  const features = enumerateFeatures(REPO_ROOT);
  const featureDiff = diffFeatures(features, baseline);
  const featureUnmappedTotal = AXES.reduce((n, axis) => n + featureDiff[axis].unmapped.length, 0);

  if (updating) {
    writeBaseline(uncovered, routes, featureDiff);
    const featureUncoveredTotal = AXES.reduce((n, axis) => n + featureDiff[axis].uncovered.length, 0);
    console.log(
      `Baseline rewritten: ${uncovered.length} uncovered operation(s), ` +
        `${featureUncoveredTotal} uncovered feature(s) parked.`,
    );
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
          features: Object.fromEntries(
            AXES.map((axis) => [
              axis,
              {
                total: featureDiff[axis].total,
                mapped: featureDiff[axis].mapped,
                unmapped: featureDiff[axis].unmapped,
                parked: featureDiff[axis].parked,
                staleBaseline: [...featureDiff[axis].nowMapped, ...featureDiff[axis].gone],
              },
            ]),
          ),
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

    const featureTotal = AXES.reduce((n, axis) => n + featureDiff[axis].total, 0);
    const featureMapped = AXES.reduce((n, axis) => n + featureDiff[axis].mapped, 0);
    console.log(
      `E2E feature traceability — ${featureMapped}/${featureTotal} named ` +
        `(UI routes, email cases, SMS cases, x-* schema markers)\n`,
    );

    if (featureUnmappedTotal) {
      console.log(`  ✗ ${featureUnmappedTotal} feature(s) named NOWHERE the gate can see:\n`);
      for (const axis of AXES) {
        for (const name of featureDiff[axis].unmapped.sort()) console.log(`      ${AXIS_LABEL[axis]}  ${name}`);
      }
      console.log(
        `\n    Name it in .claude/skills/signals-e2e/coverage.md, or annotate a spec with\n` +
          `      // @covers <ROUTE|EMAIL|SMS|SCHEMA> <name>\n` +
          `    See .claude/rules/e2e-coverage.md. Parking it in coverage-baseline.json's\n` +
          `    allowUncoveredFeatures is a last resort and needs a tracking issue.\n`,
      );
    }

    for (const axis of AXES) {
      const { nowMapped, gone } = featureDiff[axis];
      if (nowMapped.length) {
        console.log(`  ⚠ ${nowMapped.length} baseline ${AXIS_LABEL[axis]} entr(y/ies) are now named — remove them:\n`);
        for (const name of nowMapped.sort()) console.log(`      ${name}`);
        console.log('');
      }
      if (gone.length) {
        console.log(`  ⚠ ${gone.length} baseline ${AXIS_LABEL[axis]} entr(y/ies) no longer exist:\n`);
        for (const name of gone.sort()) console.log(`      ${name}`);
        console.log('');
      }
    }

    if (
      !featureUnmappedTotal &&
      AXES.every((axis) => !featureDiff[axis].nowMapped.length && !featureDiff[axis].gone.length)
    ) {
      console.log(`  ✓ every feature is either named or a known, parked gap.\n`);
    }
  }

  // Stale baseline is a warning, not a gate failure — only genuinely new
  // unmapped surface blocks, so the check stays trustworthy rather than noisy.
  process.exit(unmapped.length || featureUnmappedTotal ? 1 : 0);
}

// Guarded so `import { enumerateFeatures } from '../check-coverage.mjs'` (the
// unit test) can load this module's exports without also running the CLI —
// `main()` calls `process.exit`, which would kill the test runner before any
// assertion ran.
if (import.meta.url === `file://${process.argv[1]}`) main();
