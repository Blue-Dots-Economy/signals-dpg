import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-run namespaced identifiers so parallel runs and reruns never collide on
 * unique indexes, and so every account the suite creates is discoverable for
 * cleanup. Test users are tagged `is_test` on the target so a bulk sweep can
 * remove them (external mode can't always delete rows directly).
 */

/** One stable prefix per process run — short, filesystem/URL safe. */
export const RUN_ID = (process.env.E2E_RUN_ID ?? randomUUID().slice(0, 8)).toLowerCase();

/**
 * Deterministic 5-digit namespace derived from ANY string id — including one
 * that isn't hex, is empty, or is shorter than the old 7-char hex slice this
 * replaced. `E2E_RUN_ID` is a documented, user-settable override (RUN_ID
 * above), and the default id (a uuid slice) only happens to be hex; a value
 * like "phaseminus1" made the previous `parseInt(RUN_ID.slice(0, 7), 16)`
 * return `NaN` immediately (`p` isn't a hex digit), which then flowed,
 * unchecked, straight into a phone number (`+91900NaN0001`) and a `500` on
 * signup verify. FNV-1a is defined for every input, including the empty
 * string, and `>>> 0` before the modulo guarantees a non-negative, always-
 * in-range `[0, 100000)` result — so the `.padStart(5, '0')` below is never
 * covering for a sign or a NaN.
 */
export function runDigitsFor(id: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return String((hash >>> 0) % 100000).padStart(5, '0');
}

// A stable 5-digit numeric namespace for this run (derived from RUN_ID), so
// phone numbers from a PREVIOUS or a DIFFERENT run rarely collide with this
// one's. Exported so cleanup.sh's tag sweep can match phone-channel personas
// on the value that actually appears in the number — RUN_ID itself never
// does (it's an arbitrary, possibly non-numeric string; newPhone() embeds
// this hash of it, not the literal string) — without hand-deriving the same
// hash a second time and risking drift.
//
// RUN_DIGITS does NOT separate anything WITHIN a run — it is a pure function
// of RUN_ID, and every process in a run (every Playwright worker, however
// many there end up being) shares the same RUN_ID. What separates calls
// within a run is nextGlobalSeq() below.
export const RUN_DIGITS = runDigitsFor(RUN_ID);

/**
 * A counter shared across EVERY PROCESS in this run, not just the calling
 * one — implemented via atomic exclusive file creation on disk, because
 * nothing weaker actually works here. Two things were tried and rejected
 * first, both confirmed live against the real suite (not hypothetically):
 *
 * 1. A plain module-level counter (`let seq = 0`). Every Playwright worker
 *    is a SEPARATE OS PROCESS that imports this module fresh, so every
 *    worker's counter starts at 0 independently — worker A's first call and
 *    worker B's first call produced the IDENTICAL value. Confirmed live: a
 *    field run got three simultaneous `23505 phone_number already exists`
 *    errors from three different workers at the same millisecond.
 *
 * 2. Mixing in `TEST_PARALLEL_INDEX` (Playwright's own 0..workers-1 worker
 *    slot id) alongside a per-process counter. This fixes the SPECIFIC
 *    reported symptom (the first ~`workers` processes started by a run can
 *    no longer collide) — but `TEST_PARALLEL_INDEX` is a SLOT id, REUSED by
 *    design as workers finish and Playwright starts new ones to keep working
 *    through the remaining test files. Confirmed live, running the real
 *    suite's default 4 workers end to end: `results.json`'s own internal
 *    `workerIndex` (an ever-incrementing id, one per actual OS process
 *    spawned) reached the high 30s over a single run — meaning dozens of
 *    separate processes ran, far more than 4, each reusing one of only 4
 *    `TEST_PARALLEL_INDEX` slots. A LATER process reusing an EARLIER
 *    process's slot restarts its own per-process counter at the same
 *    starting value, so the two can still mint the identical phone number —
 *    just later in the run, and via a real `userExists: true` / `409
 *    PROFILE_LIMIT_REACHED` / `403 DOMAIN_LOCKED` (an already-committed
 *    account being reused by a second, unrelated test) rather than a `23505`
 *    (two inserts racing). Reproduced live: a full run showed exactly that
 *    shape of failure on tests that have nothing to do with each other.
 *
 * Both failure shapes come from the same root cause — the thing making a
 * call "unique" was scoped to a PROCESS, when the thing that actually needs
 * to be unique is scoped to a RUN, which spans however many processes
 * Playwright decides to start. The only mechanism that is correct regardless
 * of process count is one with state OUTSIDE any single process: an atomic
 * claim on the filesystem, scoped by RUN_ID (so concurrent/sequential runs
 * with different ids never share a counter) and living under the OS tmp dir
 * (so it needs no pre-created directory and works identically whether this
 * is called from a Playwright worker, a plain script, or a unit test).
 *
 * `open(path, 'wx')` is atomic at the OS/filesystem level — it either
 * creates the file or fails with `EEXIST`, with no window in which two
 * processes can both "win" the same number. `localNextGuess` is a per-call
 * optimization only (skip re-scanning numbers this SAME process already
 * knows are taken), never relied on for correctness — a fresh process always
 * starts its guess at 1 and just retries forward past whatever earlier
 * processes already claimed.
 */
const SEQ_LOCK_DIR = join(tmpdir(), 'signals-e2e-identity-seq', RUN_ID || 'no-run-id');
let localNextGuess = 1;

export function nextGlobalSeq(): number {
  mkdirSync(SEQ_LOCK_DIR, { recursive: true });
  let guess = localNextGuess;
  for (;;) {
    try {
      closeSync(openSync(join(SEQ_LOCK_DIR, String(guess)), 'wx'));
      localNextGuess = guess + 1;
      return guess;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        guess += 1;
        continue;
      }
      throw err;
    }
  }
}

/**
 * A unique E.164 phone per call, globally across the whole run: `+91` + `9` +
 * 5 run digits (RUN_DIGITS, separates this run from a different one) + 4
 * sequence digits (nextGlobalSeq(), separates every call within this run,
 * across however many processes make it) = 10 national digits.
 */
export function newPhone(): string {
  const seq = String(nextGlobalSeq() % 10000).padStart(4, '0');
  return `+919${RUN_DIGITS}${seq}`;
}

/** Namespaced test email; the local-part carries the run id for traceability. */
export function newEmail(label = 'user'): string {
  return `e2e+${label}.${RUN_ID}${nextGlobalSeq().toString(36)}@signals-e2e.test`;
}

/** Display name that visibly marks a row as test data. */
export function newName(label = 'E2E User'): string {
  return `${label} ${RUN_ID}-${nextGlobalSeq()}`;
}

/** The tag every test user should carry so a cleanup sweep can find them. */
export const TEST_TAG = { is_test: true } as const;
