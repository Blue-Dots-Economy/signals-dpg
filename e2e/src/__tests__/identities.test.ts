import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDigitsFor } from '../identities.ts';

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
