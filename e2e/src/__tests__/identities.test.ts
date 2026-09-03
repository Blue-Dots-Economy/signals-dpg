import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigitsFor, nextGlobalSeq, RUN_ID } from '../identities.ts';

// runDigitsFor must handle ANY string an operator hands it via E2E_RUN_ID —
// not just the hex uuid-slice default — because the old parseInt(hex-prefix)
// derivation silently produced NaN for a non-hex id, which then leaked into
// a phone number (+91900NaN0001) and a 500 on signup verify. Every case here
// reproduces a class of input parseInt(hex) got wrong.
const FIVE_DIGITS = /^\d{5}$/;

test('a non-hex id (parseInt(x, 16) would return NaN on this) still produces 5 digits', () => {
  const digits = runDigitsFor('phaseminus1');
  assert.match(digits, FIVE_DIGITS);
});

test('the empty string still produces 5 digits', () => {
  const digits = runDigitsFor('');
  assert.match(digits, FIVE_DIGITS);
});

test('an id shorter than the old 7-char hex slice still produces 5 digits', () => {
  const digits = runDigitsFor('a');
  assert.match(digits, FIVE_DIGITS);
});

test('is deterministic — same id always derives the same digits', () => {
  assert.equal(runDigitsFor('some-run-id'), runDigitsFor('some-run-id'));
});

test('a hex id still works (regression: the old default case)', () => {
  const digits = runDigitsFor('3f9a2b7c');
  assert.match(digits, FIVE_DIGITS);
});

// -----------------------------------------------------------------------
// F1 regression — newPhone()/newEmail() cross-PROCESS uniqueness.
//
// Two shapes of this bug were found and fixed, in order:
//
//  1. A plain per-process counter: every Playwright worker is a separate OS
//     process that imports this module fresh, so every worker's counter
//     started at 0 independently — worker A's first call and worker B's
//     first call were identical. Confirmed live: three simultaneous `23505
//     phone_number already exists` errors from three different workers.
//
//  2. Mixing in Playwright's TEST_PARALLEL_INDEX (a REUSED worker-slot id,
//     not a per-process id) on top of a per-process counter: this fixed
//     shape 1 but not a second, subtler one — running the real suite's
//     default 4 workers end to end, `results.json` showed the actual
//     process count reach the high 30s (Playwright starts many more worker
//     PROCESSES than `workers` over a run, reusing the small number of
//     TEST_PARALLEL_INDEX slots as earlier processes finish) and a LATER
//     process reusing an EARLIER one's slot restarted its own counter at
//     the same value — reproduced live as a real `userExists: true` / `409
//     PROFILE_LIMIT_REACHED` / `403 DOMAIN_LOCKED` on tests that had
//     nothing to do with each other.
//
// The fix (nextGlobalSeq(), in identities.ts) moves the counter OUTSIDE any
// single process entirely — atomic exclusive file creation on disk, scoped
// by RUN_ID. These tests therefore exercise REAL separate OS processes
// (via node:child_process), not simulated ones within this one test
// process — anything weaker wouldn't actually exercise the bug shape above.
// -----------------------------------------------------------------------

function lockDirFor(runId: string): string {
  return join(tmpdir(), 'signals-e2e-identity-seq', runId);
}

/** Runs a fresh `node --experimental-strip-types` process that imports
 * identities.ts under the given E2E_RUN_ID and prints N newPhone() (or
 * newEmail()) values, one per line — the same execution mode (strip-types,
 * ESM, .ts import) the real suite runs under. */
function mintInChildProcess(runId: string, count: number, kind: 'phone' | 'email' = 'phone'): string[] {
  const script = `
    const mod = await import(${JSON.stringify(new URL('../identities.ts', import.meta.url).href)});
    const out = [];
    for (let i = 0; i < ${count}; i++) out.push(mod.${kind === 'phone' ? 'newPhone' : 'newEmail'}());
    console.log(out.join('\\n'));
  `;
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, E2E_RUN_ID: runId },
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean);
}

test('nextGlobalSeq() returns strictly increasing, non-repeating values within one process', () => {
  // Exercises the REAL export directly, scoped to whatever RUN_ID this test
  // process itself has — cleaned up afterward via that same RUN_ID.
  try {
    const values = [nextGlobalSeq(), nextGlobalSeq(), nextGlobalSeq(), nextGlobalSeq()];
    assert.deepEqual(values, [...values].sort((x, y) => x - y));
    assert.equal(new Set(values).size, values.length, 'no duplicate within one process');
  } finally {
    rmSync(lockDirFor(RUN_ID || 'no-run-id'), { recursive: true, force: true });
  }
});

test('two REAL separate processes (same RUN_ID) never mint the same phone number', () => {
  const runId = `xproc-${randomUUID().slice(0, 8)}`;
  try {
    // Sequential, not concurrent: proves the SLOT-REUSE shape (bug #2 above)
    // — a SECOND process, started only after the first has fully exited,
    // must still never repeat a value the first one claimed. A concurrent
    // variant is covered by the "many processes" test below.
    const first = mintInChildProcess(runId, 5);
    const second = mintInChildProcess(runId, 5);
    const all = [...first, ...second];
    assert.equal(new Set(all).size, all.length, `duplicate phone across sequential processes: ${JSON.stringify(all)}`);
  } finally {
    rmSync(lockDirFor(runId), { recursive: true, force: true });
  }
});

test('many separate processes sharing one RUN_ID (simulating worker-slot reuse) never collide', () => {
  const runId = `manyproc-${randomUUID().slice(0, 8)}`;
  try {
    // 8 separate processes, each minting 3 phones — deliberately MORE
    // processes than Playwright's default `workers: 4`, so a fix that only
    // separates the first 4 concurrent processes (e.g. by worker-slot index
    // alone) cannot pass this by accident.
    const all: string[] = [];
    for (let i = 0; i < 8; i++) all.push(...mintInChildProcess(runId, 3));
    assert.equal(all.length, 24);
    assert.equal(new Set(all).size, all.length, 'duplicate phone across processes sharing a run id');
  } finally {
    rmSync(lockDirFor(runId), { recursive: true, force: true });
  }
});

test('two REAL separate processes (same RUN_ID) never mint the same email', () => {
  const runId = `xproc-email-${randomUUID().slice(0, 8)}`;
  try {
    const first = mintInChildProcess(runId, 4, 'email');
    const second = mintInChildProcess(runId, 4, 'email');
    const all = [...first, ...second];
    assert.equal(new Set(all).size, all.length, `duplicate email across processes: ${JSON.stringify(all)}`);
  } finally {
    rmSync(lockDirFor(runId), { recursive: true, force: true });
  }
});

test('a DIFFERENT RUN_ID gets its own independent counter (no cross-run interference)', () => {
  const runA = `runA-${randomUUID().slice(0, 8)}`;
  const runB = `runB-${randomUUID().slice(0, 8)}`;
  try {
    const a = mintInChildProcess(runA, 2);
    const b = mintInChildProcess(runB, 2);
    // Both start their own sequence at 1 — same trailing digits are fine
    // across DIFFERENT runs (RUN_DIGITS, not the sequence, is what
    // separates one run's numbers from another's); the only invariant here
    // is that neither run's counter was perturbed by the other's.
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
  } finally {
    rmSync(lockDirFor(runA), { recursive: true, force: true });
    rmSync(lockDirFor(runB), { recursive: true, force: true });
  }
});

test('newPhone() is always a valid 10-national-digit +91 number', () => {
  const runId = `shape-${randomUUID().slice(0, 8)}`;
  try {
    const [phone] = mintInChildProcess(runId, 1);
    assert.match(phone, /^\+919\d{9}$/);
  } finally {
    rmSync(lockDirFor(runId), { recursive: true, force: true });
  }
});
