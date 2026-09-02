import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateClause, classifyRequest } from '../search.ts';

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

test('a hostile field name is rejected rather than spliced into the SQL', () => {
  // A crafted target could otherwise turn `(i.item_state ->> 'x') = $1` into
  // something like `... = $1) OR (TRUE` — bypassing the lifecycle/network/
  // domain/item_type scoping applied elsewhere in the same SELECT. The field
  // name is a JSONB key literal, not a bind parameter, so it must be
  // allowlisted rather than trusted.
  assert.throws(
    () => translateClause({ op: 'eq', target: "item_state.x') OR ('1'='1", value: 'y' }),
    /unsafe field name/,
  );
});

test('a legitimate field name with an underscore still passes', () => {
  assert.doesNotThrow(() => translateClause({ op: 'eq', target: 'item_state.disability_type', value: 'x' }));
});

test('classifyRequest rejects a missing api key without needing a parseable body', () => {
  const result = classifyRequest({ hasApiKey: false, rawBody: 'not json at all', mode: 'ok' });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'UNAUTHORIZED');
});

test('classifyRequest rejects invalid JSON as a distinct, recorded rejection', () => {
  const result = classifyRequest({ hasApiKey: true, rawBody: '{not valid json', mode: 'ok' });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'INVALID_REQUEST');
  assert.equal(result.envelope, null);
});

test('classifyRequest rejects a bad shape but still captures the envelope for the audit trail', () => {
  const rawBody = JSON.stringify({
    context: { version: '1.0.0', messageId: 'm1', networkId: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0' },
    message: { intent: {}, pagination: { limit: 0, offset: 0 } }, // limit=0 is out of range
  });
  const result = classifyRequest({ hasApiKey: true, rawBody, mode: 'ok' });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'INVALID_REQUEST');
  // Recorded even though rejected — this is what makes "no malformed
  // envelope was ever sent" an assertable claim rather than a blind spot.
  assert.ok(result.envelope);
});

test('classifyRequest accepts a well-formed envelope and defers the 200-vs-500 status', () => {
  const rawBody = JSON.stringify({
    context: { version: '1.0.0', messageId: 'm2', networkId: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0' },
    message: { intent: {}, pagination: { limit: 10, offset: 0 } },
  });
  const result = classifyRequest({ hasApiKey: true, rawBody, mode: 'ok' });
  assert.equal(result.accepted, true);
  assert.equal(result.status, null); // caller learns 200 vs 500 only after the DB query
  assert.ok(result.envelope);
});

test('classifyRequest returns ANCHOR_NOT_FOUND as an ACCEPTED terminal outcome, not a rejection', () => {
  const rawBody = JSON.stringify({
    context: { version: '1.0.0', messageId: 'm3', networkId: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0' },
    message: { intent: { item: { id: 'deadbeef-0000-0000-0000-000000000000' } }, pagination: { limit: 10, offset: 0 } },
  });
  const result = classifyRequest({ hasApiKey: true, rawBody, mode: 'anchor-not-found' });
  // The envelope was well-formed — the API asked correctly — so this is an
  // ACCEPTED request that happens to terminate early, distinct from the
  // reject cases above (bad auth / bad shape).
  assert.equal(result.accepted, true);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'ANCHOR_NOT_FOUND');
});
