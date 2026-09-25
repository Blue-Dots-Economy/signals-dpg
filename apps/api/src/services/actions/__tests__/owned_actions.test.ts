import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildOwnedActionsWhere,
  counterpartyItemId,
  ownItemId,
  stateMatchesFacets,
} from '../owned_actions';

const dialect = new PgDialect();
const render = (userId: string, f: Parameters<typeof buildOwnedActionsWhere>[1]) => {
  const where = buildOwnedActionsWhere(userId, f);
  if (!where) throw new Error('expected a where clause');
  return dialect.sqlToQuery(where);
};

describe('buildOwnedActionsWhere', () => {
  it('always scopes to the caller — either side for "all"', () => {
    const q = render('u1', { ownership_role: 'all' });
    expect(q.sql).toContain('"source_item_owner" = $1');
    expect(q.sql).toContain('"target_item_owner" = $2');
    expect(q.params).toEqual(['u1', 'u1']);
  });

  it('initiated scopes to the source owner only', () => {
    const q = render('u1', { ownership_role: 'initiated' });
    expect(q.sql).toContain('"source_item_owner"');
    expect(q.sql).not.toContain('"target_item_owner"');
  });

  it('received scopes to the target owner only', () => {
    const q = render('u1', { ownership_role: 'received' });
    expect(q.sql).toContain('"target_item_owner"');
    expect(q.sql).not.toContain('"source_item_owner"');
  });

  it('applies ids, types, statuses, item and date window', () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T00:00:00Z');
    const q = render('u1', {
      ownership_role: 'all',
      action_ids: ['a1', 'a2'],
      action_type: ['connect'],
      action_status: ['accepted'],
      item_id: 'i1',
      updated_from: from,
      updated_to: to,
    });
    expect(q.sql).toContain('"action_id" in ($1, $2)');
    expect(q.sql).toContain('"action_type" in ($3)');
    expect(q.sql).toContain('"action_status" in ($4)');
    expect(q.sql).toContain('"updated_at" >= $5');
    expect(q.sql).toContain('"updated_at" <= $6');
    expect(q.sql).toContain('"source_item_id" = $7');
    expect(q.sql).toContain('"target_item_id" = $8');
    expect(q.params.slice(0, 4)).toEqual(['a1', 'a2', 'connect', 'accepted']);
  });

  it('item_id on initiated narrows the source side only', () => {
    const q = render('u1', { ownership_role: 'initiated', item_id: 'i1' });
    expect(q.sql).toContain('"source_item_id" = $1');
    expect(q.sql).not.toContain('"target_item_id"');
  });
});

describe('buildOwnedActionsWhere — counterparty filters (#770 review #1)', () => {
  it('counterparty_domain matches the side the caller does not own', () => {
    const q = render('u1', { ownership_role: 'all', counterparty_domain: 'seeker' });
    // (target owner = me AND source domain = seeker) OR (source owner = me AND target domain = seeker)
    expect(q.sql).toMatch(/"target_item_owner" = \$\d+ and "item_actions"\."source_item_domain" = \$\d+/);
    expect(q.sql).toMatch(/"source_item_owner" = \$\d+ and "item_actions"\."target_item_domain" = \$\d+/);
    expect(q.params).toContain('seeker');
  });

  it('counterparty_item_type narrows the same way', () => {
    const q = render('u1', { ownership_role: 'all', counterparty_item_type: 'profile_1.0' });
    expect(q.sql).toContain('"source_item_type"');
    expect(q.sql).toContain('"target_item_type"');
    expect(q.params).toContain('profile_1.0');
  });
});

describe('counterparty / own side', () => {
  const row = { source_item_id: 'S', target_item_id: 'T', target_item_owner: 'owner-t' };

  it('received (caller owns target) → counterparty is source', () => {
    expect(counterpartyItemId(row, 'owner-t')).toBe('S');
    expect(ownItemId(row, 'owner-t')).toBe('T');
  });

  it('initiated (caller owns source) → counterparty is target', () => {
    expect(counterpartyItemId(row, 'owner-s')).toBe('T');
    expect(ownItemId(row, 'owner-s')).toBe('S');
  });
});

describe('stateMatchesFacets', () => {
  it('passes with no selections', () => {
    expect(stateMatchesFacets({}, [])).toBe(true);
  });

  it('matches scalars and arrays by intersection', () => {
    const state = { gender: 'Female', looking_for: ['Education', 'Pension'] };
    expect(stateMatchesFacets(state, [{ field: 'gender', values: ['Female'] }])).toBe(true);
    expect(stateMatchesFacets(state, [{ field: 'looking_for', values: ['Pension'] }])).toBe(true);
    expect(stateMatchesFacets(state, [{ field: 'looking_for', values: ['Loans'] }])).toBe(false);
  });

  it('requires every selection and fails on a missing field', () => {
    const state = { gender: 'Female' };
    expect(
      stateMatchesFacets(state, [
        { field: 'gender', values: ['Female'] },
        { field: 'age_band', values: ['18-25'] },
      ])
    ).toBe(false);
  });
});
