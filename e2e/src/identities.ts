import { randomUUID } from 'node:crypto';

/**
 * Per-run namespaced identifiers so parallel runs and reruns never collide on
 * unique indexes, and so every account the suite creates is discoverable for
 * cleanup. Test users are tagged `is_test` on the target so a bulk sweep can
 * remove them (external mode can't always delete rows directly).
 */

/** One stable prefix per process run — short, filesystem/URL safe. */
export const RUN_ID = (process.env.E2E_RUN_ID ?? randomUUID().slice(0, 8)).toLowerCase();

let counter = 0;
function next(): string {
  counter += 1;
  return `${RUN_ID}${counter.toString(36)}`;
}

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
// phone numbers from different worker processes rarely collide. Exported so
// cleanup.sh's tag sweep can match phone-channel personas on the value that
// actually appears in the number — RUN_ID itself never does (it's an
// arbitrary, possibly non-numeric string; newPhone() embeds this hash of it,
// not the literal string) — without hand-deriving the same hash a second
// time and risking drift.
export const RUN_DIGITS = runDigitsFor(RUN_ID);
let phoneSeq = 0;

/**
 * A unique E.164 phone per call: `+91` + `9` + 5 run digits + 4 sequence digits
 * = 10 national digits. The sequence guarantees uniqueness within a run; the run
 * digits separate parallel workers. (The previous implementation sliced the
 * varying part off and returned the same number every call.)
 */
export function newPhone(): string {
  phoneSeq += 1;
  const seq = String(phoneSeq % 10000).padStart(4, '0');
  return `+919${RUN_DIGITS}${seq}`;
}

/** Namespaced test email; the local-part carries the run id for traceability. */
export function newEmail(label = 'user'): string {
  return `e2e+${label}.${next()}@signals-e2e.test`;
}

/** Display name that visibly marks a row as test data. */
export function newName(label = 'E2E User'): string {
  return `${label} ${RUN_ID}-${counter}`;
}

/** The tag every test user should carry so a cleanup sweep can find them. */
export const TEST_TAG = { is_test: true } as const;
