import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, parseSuiteTable, SUITES } from '../../../.claude/skills/signals-e2e/lib/report.mjs';

const results = {
  suites: [{
    title: 'journey-a', specs: [
      { title: 'creates a profile', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'rejects a bad payload', ok: false, tests: [{ results: [{ status: 'failed', error: { message: 'expected 409 got 503' } }] }] },
      { title: 'decrypts a participant', ok: true, tests: [{ results: [{ status: 'skipped' }], annotations: [{ type: 'skip', description: '[capability] requires service-caller credentials' }] }] },
    ],
  }],
};

test('passes, failures and skips land in their own sections', () => {
  const r = buildReport({ results, humanOnly: ['brand skin correctness'], scoped: null, residue: 0 });
  assert.equal(r.working.length, 2);
  assert.equal(r.notWorking.length, 1);
  assert.match(r.notWorking[0].detail, /expected 409 got 503/);
  assert.ok(r.needsHuman.some((h) => /service-caller credentials/.test(h)));
  assert.ok(r.needsHuman.includes('brand skin correctness'));
});

test('a scoped run names every suite it did not run', () => {
  const r = buildReport({ results, humanOnly: [], scoped: { alias: 'u18', suites: [5] }, residue: 0 });
  assert.ok(r.needsHuman.some((h) => /not run in this invocation/.test(h)));
});

test('cleanup residue is a failure, not a footnote', () => {
  const r = buildReport({ results, humanOnly: [], scoped: null, residue: 3 });
  assert.ok(r.notWorking.some((f) => /residue/i.test(f.detail)));
});

test('exit code is non-zero only when section 2 is non-empty', () => {
  const clean = { suites: [{ title: 's', specs: [{ title: 't', ok: true, tests: [{ results: [{ status: 'passed' }] }] }] }] };
  assert.equal(buildReport({ results: clean, humanOnly: [], scoped: null, residue: 0 }).exitCode, 0);
  assert.equal(buildReport({ results, humanOnly: [], scoped: null, residue: 0 }).exitCode, 1);
});

test('parseSuiteTable reads coverage.md into the same shape as SUITES', () => {
  const text = readFileSync(
    new URL('../../../.claude/skills/signals-e2e/coverage.md', import.meta.url),
    'utf8',
  );
  assert.deepEqual(parseSuiteTable(text), SUITES);
});

test('a scoped run can be told to use a caller-supplied suite catalogue', () => {
  const r = buildReport({
    results,
    humanOnly: [],
    scoped: { alias: 'x', suites: [1] },
    residue: 0,
    suites: [{ id: 1, name: 'Only one' }, { id: 2, name: 'Another' }],
  });
  assert.ok(r.needsHuman.includes('Suite 2 (Another) — not run in this invocation'));
  assert.ok(!r.needsHuman.some((h) => h.includes('Suite 1')));
});

test('parseSuiteTable rejects a markdown file with no suite table', () => {
  assert.throws(() => parseSuiteTable('# nothing here\n'), /parsed to zero rows/);
});
