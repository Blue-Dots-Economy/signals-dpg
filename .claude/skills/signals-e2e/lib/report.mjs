// The five-section signoff. A Playwright list reporter answers "did the suite
// pass"; the question a signoff has to answer is "can this ship, and what did
// nobody check" — which needs the skips and the untestable surface promoted to
// first-class output rather than scrolled past.
//
// Five sections, in this fixed order:
//   1. Working       — passes, grouped by suite.
//   2. Not working    — failures, each with the error and the trace/screenshot
//                        path. Cleanup residue lands here too, as a synthetic
//                        entry, because a run that leaves rows behind makes the
//                        next run lie.
//   3. Known/expected — specs annotated `@known`, so documented look-like-bugs
//                        (the map count below the list total, `x-uri` through a
//                        `$ref`) never pollute section 2.
//   4. Needs a human   — COMPUTED, never hand-written: every capability skip's
//                        reason, plus coverage.md's `human-only` block, plus —
//                        on a scoped run — one line per suite this run did not
//                        touch, worded "not run in this invocation".
//   5. Coverage drift  — whatever `npm run coverage` found unmapped, passed in
//                        by the caller (that check lives in scripts/, this file
//                        only renders what it's told).
//
// Exit code is non-zero if and only if section 2 is non-empty. A bare
// `test.skip` (no capability reason, no annotation) is NOT quietly dropped —
// `capabilities.ts` guarantees a reason for every capability skip, so a skip
// with none is itself a defect and is surfaced in section 2, not folded into
// "needs a human" where it would look like an intentional, documented gap.
//
// `buildReport` returns plain data (`ReportSections`); `renderMarkdown` is the
// only thing that knows about headings and bullet formatting, so a future
// caller (a Slack summary, a GitHub check) can consume the data without
// parsing markdown back out of it.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The suite catalogue (spec §4). This mirrors `coverage.md`'s table by hand —
// `buildReport`'s input contract is fixed at `{results, humanOnly, scoped,
// residue}` (Task 10 depends on that exact shape), so the catalogue can't be
// threaded through as parsed markdown. If a suite is renumbered, update both.
// ---------------------------------------------------------------------------
export const SUITES = [
  { id: 0, name: 'Preflight & stack-up' },
  { id: 1, name: 'Config, schema, served domains' },
  { id: 2, name: 'Auth & account' },
  { id: 3, name: 'User consent + legal' },
  { id: 4, name: 'Profile creation (schema-driven)' },
  { id: 5, name: 'U18 / guardian' },
  { id: 6, name: 'Browse / list' },
  { id: 7, name: 'Map' },
  { id: 8, name: 'Actions' },
  { id: 9, name: 'Match score' },
  { id: 10, name: 'Lifecycle' },
  { id: 11, name: 'Public / shareable profile' },
  { id: 12, name: 'Contact support' },
  { id: 13, name: 'Integrator surface' },
  { id: 14, name: 'Inter-instance / peer' },
  { id: 15, name: 'Cross-cutting UI' },
  { id: 16, name: 'Tourist (orange_dot)' },
];

const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

/**
 * Parse `coverage.md`'s `## human-only` block.
 *
 * Format: a `## human-only` heading, then `- entry` bullets until the next
 * `##` heading or end of file. Blank lines and HTML comments (`<!-- ... -->`,
 * single- or multi-line) are tolerated and skipped. Anything else in the
 * block — a stray paragraph, a malformed bullet, an empty bullet — is a loud
 * error, not a silently-dropped line: this list exists specifically to tell a
 * reader what still needs their attention, so a parser that quietly produces
 * fewer entries than were written is worse than one that refuses to run.
 *
 * An empty block (heading present, zero entries) is also a hard error: it
 * would tell a reader "nothing needs your attention", which is the exact lie
 * this section exists to prevent.
 */
export function parseHumanOnly(markdown) {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^##\s+human-only\s*$/i.test(l.trim()));
  if (startIdx === -1) {
    throw new Error(
      "coverage.md is missing its '## human-only' section. This block is load-bearing " +
        '(it feeds section 4 of the signoff report) — a missing section is a hard error, not an empty list.',
    );
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const entries = [];
  let inComment = false;
  for (const raw of lines.slice(startIdx + 1, endIdx)) {
    const line = raw.trim();
    if (line === '') continue;

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }

    const m = /^[-*]\s+(.+)$/.exec(line);
    if (!m) {
      throw new Error(
        `coverage.md's human-only block has an unrecognised line (expected "- entry", ` +
          `a blank line, or an HTML comment): "${raw}"`,
      );
    }
    const entry = m[1].trim();
    if (!entry) {
      throw new Error("coverage.md's human-only block has an empty bullet entry.");
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    throw new Error(
      "coverage.md's human-only block parsed to zero entries. An empty list here would tell " +
        'a reader nothing needs their attention, which is exactly the lie this section exists to prevent.',
    );
  }
  return entries;
}

/** True if any annotation marks this as a documented, non-bug behaviour. */
function hasKnownAnnotation(annotations) {
  return annotations.some(
    (a) => a && (a.type === 'known' || (typeof a.description === 'string' && /@known\b/.test(a.description))),
  );
}

/** The capability (or other) reason attached to a skip, if any. */
function skipReason(annotations) {
  const capability = annotations.find(
    (a) => a && typeof a.description === 'string' && a.description.startsWith('[capability]'),
  );
  if (capability) return capability.description.replace(/^\[capability\]\s*/, '').trim();

  const anyReasoned = annotations.find((a) => a && a.type === 'skip' && typeof a.description === 'string' && a.description.trim());
  return anyReasoned ? anyReasoned.description.trim() : null;
}

/** The last (authoritative) result per `test` entry — a retry that later passed is not a failure. */
function finalResults(spec) {
  return (spec.tests ?? []).map((t) => {
    const results = t.results ?? [];
    return { test: t, result: results[results.length - 1] ?? null };
  });
}

function findAttachmentPath(results, name) {
  for (const r of results) {
    const hit = (r.attachments ?? []).find((a) => a && a.name === name && a.path);
    if (hit) return hit.path;
  }
  return null;
}

function tracePathFor(results) {
  return findAttachmentPath(results, 'trace') ?? findAttachmentPath(results, 'screenshot');
}

function errorMessagesFor(results) {
  const msgs = [];
  for (const r of results) {
    // The JSON reporter carries both the newer `errors[]` array and the
    // older singular `error` field for the SAME failure — prefer the array
    // and only fall back to the singular field when it is absent, or every
    // failure would be reported twice.
    const fromArray = (r.errors ?? []).map((e) => e?.message).filter(Boolean);
    if (fromArray.length) msgs.push(...fromArray.map(stripAnsi));
    else if (r.error?.message) msgs.push(stripAnsi(r.error.message));
  }
  return msgs.length ? msgs : ['(no error message captured)'];
}

/** Walk the (possibly nested) Playwright JSON suite tree, yielding each leaf spec with its suite path. */
function* walkSpecs(suites, path = []) {
  for (const suite of suites ?? []) {
    const nextPath = [...path, suite.title];
    if (suite.suites?.length) yield* walkSpecs(suite.suites, nextPath);
    for (const spec of suite.specs ?? []) yield { spec, path: nextPath };
  }
}

/**
 * Build the five report sections from a Playwright JSON reporter payload plus
 * the run's other signoff inputs. Pure function — no I/O — so it is exactly
 * what `report.test.ts` drives directly.
 *
 * @param {object} input
 * @param {{suites: any[]}} input.results   Parsed Playwright JSON reporter output.
 * @param {string[]} input.humanOnly        `coverage.md`'s parsed human-only list.
 * @param {{alias: string, suites: number[]} | null} input.scoped  Set on a scoped run.
 * @param {number} input.residue            `cleanup.sh`'s residue table count (0 = clean).
 * @param {string[]} [input.coverageDrift]  Pre-formatted lines from `npm run coverage --json`.
 */
export function buildReport(input) {
  const { results, humanOnly = [], scoped = null, residue = 0, coverageDrift = [] } = input;

  const working = [];
  const notWorking = [];
  const known = [];
  const skipReasons = [];

  for (const { spec, path } of walkSpecs(results.suites)) {
    const suiteLabel = path[0] ?? '(root)';
    const attempts = finalResults(spec).filter((a) => a.result);
    const results_ = attempts.map((a) => a.result);
    const annotations = [
      ...(spec.annotations ?? []),
      ...attempts.flatMap((a) => a.test.annotations ?? []),
    ];

    const failed = results_.some((r) => r.status === 'failed' || r.status === 'timedOut');
    const skipped = !failed && results_.some((r) => r.status === 'skipped');
    const allPassed = results_.length > 0 && results_.every((r) => r.status === 'passed');

    if (failed) {
      const detail =
        `${suiteLabel} › ${spec.title}\n  ${errorMessagesFor(results_).join('\n  ')}` +
        (tracePathFor(results_) ? `\n  trace: ${tracePathFor(results_)}` : '\n  trace: (none captured)');
      const entry = { suite: suiteLabel, title: spec.title, detail, trace: tracePathFor(results_) };
      if (hasKnownAnnotation(annotations)) known.push(entry);
      else notWorking.push(entry);
      continue;
    }

    if (skipped) {
      const reason = skipReason(annotations);
      if (reason) {
        skipReasons.push(reason);
        // Not a failure — the environment chose not to run it, on purpose,
        // for a stated reason. It still "worked" in the sense of not being
        // broken; the reason itself is what makes section 4 honest.
        working.push({ suite: suiteLabel, title: spec.title, skipped: true });
      } else {
        // A bare `test.skip` with no reason at all. `capabilities.ts`
        // guarantees a reason for every capability skip, so the absence of
        // one means someone wrote a naked skip — that is a defect in the
        // suite, not a documented gap, and belongs in section 2.
        notWorking.push({
          suite: suiteLabel,
          title: spec.title,
          detail: `${suiteLabel} › ${spec.title}\n  skipped with no reason (a bare test.skip is a defect — every capability skip must carry a reason)`,
          trace: null,
        });
      }
      continue;
    }

    if (allPassed) {
      working.push({ suite: suiteLabel, title: spec.title, skipped: false });
    }
  }

  if (residue > 0) {
    notWorking.push({
      suite: 'cleanup',
      title: 'post-run residue check',
      detail:
        `cleanup.sh reported residue in ${residue} table(s) after teardown. A run that leaves rows ` +
        'behind makes the next run lie (newPhone() derives its sequence from the run id, so leftover ' +
        "rows collide with the next run's identities) — that is worth failing over, not a footnote.",
      trace: null,
    });
  }

  const needsHuman = [...skipReasons, ...humanOnly];
  if (scoped) {
    const ran = new Set(scoped.suites ?? []);
    for (const suite of SUITES) {
      if (!ran.has(suite.id)) {
        needsHuman.push(`Suite ${suite.id} (${suite.name}) — not run in this invocation`);
      }
    }
  }

  return {
    working,
    notWorking,
    known,
    needsHuman,
    coverageDrift,
    scoped,
    exitCode: notWorking.length > 0 ? 1 : 0,
  };
}

function groupBySuite(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.suite)) groups.set(e.suite, []);
    groups.get(e.suite).push(e);
  }
  return groups;
}

/** Render the five sections as markdown, in fixed order. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Signals DPG — end-to-end signoff');
  lines.push('');
  lines.push(
    report.scoped
      ? `> Scoped run — alias \`${report.scoped.alias}\`, suites [${(report.scoped.suites ?? []).join(', ')}]. ` +
          'Section 4 names every suite this invocation did not touch, so this can never be misread as a full signoff.'
      : '> Full run — every suite in the catalogue.',
  );
  lines.push('');

  lines.push('## 1. Working');
  const passing = groupBySuite(report.working.filter((w) => !w.skipped));
  if (passing.size === 0) {
    lines.push('_Nothing passed._');
  } else {
    for (const [suite, items] of passing) {
      lines.push(`**${suite}**`);
      for (const item of items) lines.push(`- ${item.title}`);
    }
  }
  lines.push('');

  lines.push('## 2. Not working');
  if (report.notWorking.length === 0) {
    lines.push('_None — exit code 0._');
  } else {
    for (const f of report.notWorking) {
      lines.push(`### ${f.suite} — ${f.title}`);
      lines.push(f.detail);
      lines.push('');
    }
  }

  lines.push('## 3. Known / expected');
  if (report.known.length === 0) {
    lines.push('_None flagged this run._');
  } else {
    for (const k of report.known) lines.push(`- **${k.suite} — ${k.title}**: ${k.detail}`);
  }
  lines.push('');

  lines.push('## 4. Not tested — needs a human');
  if (report.needsHuman.length === 0) {
    lines.push('_Nothing — unusual; check that coverage.md loaded correctly._');
  } else {
    for (const h of report.needsHuman) lines.push(`- ${h}`);
  }
  lines.push('');

  lines.push('## 5. Coverage drift');
  if (report.coverageDrift.length === 0) {
    lines.push('_Nothing unmapped._');
  } else {
    for (const d of report.coverageDrift) lines.push(`- ${d}`);
  }
  lines.push('');

  lines.push(`Exit code: ${report.exitCode}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI: `node report.mjs --results <path> [--coverage <coverage.md path>]
//        [--residue <n>] [--scoped-alias <a> --scoped-suites 1,2,3]
//        [--coverage-drift <path to a JSON array of strings>]`
// Prints the markdown report to stdout and exits with the report's code —
// the shape `run.sh` (Task 10) needs to fail the whole invocation on section 2.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next;
    i += 1;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsPath = args.results ?? 'test-results/results.json';
  const coveragePath = args.coverage ?? new URL('../coverage.md', import.meta.url).pathname;
  const residue = Number(args.residue ?? 0);

  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const humanOnly = parseHumanOnly(readFileSync(coveragePath, 'utf8'));
  const scoped =
    args['scoped-alias'] && args['scoped-suites']
      ? { alias: args['scoped-alias'], suites: args['scoped-suites'].split(',').map(Number) }
      : null;
  const coverageDrift = args['coverage-drift'] ? JSON.parse(readFileSync(args['coverage-drift'], 'utf8')) : [];

  const report = buildReport({ results, humanOnly, scoped, residue, coverageDrift });
  console.log(renderMarkdown(report));
  process.exit(report.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
