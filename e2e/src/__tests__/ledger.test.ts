import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, appendFileSync } from 'node:fs';
import { recordCreated, readLedger, ledgerPath, CLEANUP_TABLES } from '../ledger.ts';

const RUN = 'unit-test-run';

test('recordCreated appends readable JSONL and readLedger round-trips it', () => {
  rmSync(ledgerPath(RUN), { force: true });
  recordCreated('items', 'aaa-111', RUN);
  recordCreated('user', 'bbb-222', RUN);
  const rows = readLedger(RUN);
  assert.deepEqual(rows, [
    { table: 'items', pk: 'aaa-111' },
    { table: 'user', pk: 'bbb-222' },
  ]);
  assert.ok(existsSync(ledgerPath(RUN)));
  rmSync(ledgerPath(RUN), { force: true });
});

test('readLedger tolerates a truncated final line from a killed run', () => {
  rmSync(ledgerPath(RUN), { force: true });
  recordCreated('items', 'ccc-333', RUN);
  appendFileSync(ledgerPath(RUN), '{"table":"items","pk":');
  assert.deepEqual(readLedger(RUN), [{ table: 'items', pk: 'ccc-333' }]);
  rmSync(ledgerPath(RUN), { force: true });
});

test('CLEANUP_TABLES deletes children before parents', () => {
  const order = CLEANUP_TABLES;
  assert.ok(order.indexOf('action_events') < order.indexOf('item_actions'));
  assert.ok(order.indexOf('item_actions') < order.indexOf('items'));
  assert.ok(order.indexOf('items') < order.indexOf('user'));
  assert.ok(order.indexOf('consent_record') < order.indexOf('user'));
});
