import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowForEvent } from '../../../.claude/skills/signals-e2e/lib/index_row.mjs';

const EV = { item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0', item_id: 'i-1', op: 'upsert' };

test('a delete event removes the row', () => {
  const out = rowForEvent({ ...EV, op: 'delete' }, null, []);
  assert.equal(out.delete, true);
});

test('an upsert carries lifecycle_status and source_updated_at from items', () => {
  const item = { lifecycle_status: 'live', updated_at: '2026-09-02T00:00:00Z' };
  const out = rowForEvent(EV, item, [{ lat: 12.9, lng: 77.6 }]);
  assert.match(out.text, /INSERT INTO item_search/i);
  assert.ok(out.params.includes('live'));
  assert.ok(out.params.includes('2026-09-02T00:00:00Z'));
});

test('an upsert for an item that no longer exists is a delete, not a stale row', () => {
  const out = rowForEvent(EV, null, []);
  assert.equal(out.delete, true);
});

test('an item with no locations still indexes, with null geo', () => {
  const out = rowForEvent(EV, { lifecycle_status: 'draft', updated_at: '2026-09-02T00:00:00Z' }, []);
  assert.ok(out.params.includes(null));
});
