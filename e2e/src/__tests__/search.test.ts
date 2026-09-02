import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateClause } from '../search.ts';

test('an array facet uses jsonb overlap, never equality', () => {
  // The client comment is explicit: `in` on an array field extracts the
  // serialized array as TEXT and never matches a single scalar, so a
  // one-value selection would silently return nothing.
  const { sql } = translateClause({ op: 'contains_any', target: 'item_state.disability_type', value: ['Autism'] });
  assert.match(sql, /\?\|/);
});

test('a scalar facet uses ANY over the extracted text', () => {
  const { sql, params } = translateClause({ op: 'in', target: 'item_state.gender', value: ['Male', 'Female'] });
  assert.match(sql, /->>/);
  assert.deepEqual(params, [['Male', 'Female']]);
});

test('an unknown op is rejected rather than silently ignored', () => {
  assert.throws(() => translateClause({ op: 'nope', target: 'item_state.x', value: 1 }), /nope/);
});

test('a target outside item_state is rejected', () => {
  assert.throws(() => translateClause({ op: 'eq', target: 'user.email', value: 'x' }), /item_state/);
});
