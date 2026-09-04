import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireDb, DbNotConfiguredError } from '../db.ts';

test('requireDb throws a named, actionable error when db.url is unset', () => {
  const cfg = { db: { url: null } } as never;
  assert.throws(() => requireDb(cfg), (err: Error) => {
    assert.ok(err instanceof DbNotConfiguredError);
    assert.match(err.message, /E2E_DB_URL/);
    return true;
  });
});

test('requireDb returns a client when db.url is set', () => {
  const cfg = { db: { url: 'postgres://u:p@localhost:5432/signals' } } as never;
  const db = requireDb(cfg);
  assert.equal(typeof db.query, 'function');
  assert.equal(typeof db.close, 'function');
});
