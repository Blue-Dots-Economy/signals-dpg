import { describe, expect, it } from 'vitest';
import { ExportActionsBodySchema } from '../api/action_schemas';

// #770: POST /api/v1/action/export request body.

const UUID = '3f9a1c2e-0000-4000-8000-000000000001';

describe('ExportActionsBodySchema', () => {
  it('defaults an empty body to all-roles, all fields, csv', () => {
    const parsed = ExportActionsBodySchema.parse({});
    expect(parsed).toEqual({
      filters: { ownership_role: 'all' },
      projection: { fields: '*' },
      include: [],
      format: 'csv',
    });
  });

  it('accepts the v1 UI request shape', () => {
    const parsed = ExportActionsBodySchema.parse({
      filters: {
        item_id: UUID,
        ownership_role: 'all',
        action_ids: [UUID],
        action_status: ['accepted'],
        counterparty_domain: 'seeker',
      },
      projection: { fields: '*' },
      format: 'csv',
    });
    expect(parsed.filters.counterparty_domain).toBe('seeker');
    expect(parsed.filters.action_ids).toEqual([UUID]);
  });

  it('accepts a field list projection', () => {
    const parsed = ExportActionsBodySchema.parse({
      projection: { fields: ['beneficiary_name', 'mobile_number'] },
    });
    expect(parsed.projection.fields).toEqual(['beneficiary_name', 'mobile_number']);
  });

  it('coerces ISO date-times for the updated window', () => {
    const parsed = ExportActionsBodySchema.parse({
      filters: { updated_from: '2026-09-01T00:00:00Z', updated_to: '2026-09-30T00:00:00Z' },
    });
    expect(parsed.filters.updated_from).toBeInstanceOf(Date);
    expect(parsed.filters.updated_to).toBeInstanceOf(Date);
  });

  it.each([
    ['unknown format', { format: 'xlsx' }],
    ['empty field list', { projection: { fields: [] } }],
    ['non-uuid action id', { filters: { action_ids: ['nope'] } }],
    ['empty action_ids', { filters: { action_ids: [] } }],
    ['unknown include', { include: ['everything'] }],
    ['unknown ownership role', { filters: { ownership_role: 'mine' } }],
    ['bad date', { filters: { updated_from: 'yesterday' } }],
    ['unknown top-level key', { extra: true }],
    ['unknown filter key', { filters: { status: 'accepted' } }],
  ])('rejects %s', (_label, body) => {
    expect(ExportActionsBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts match_score in include', () => {
    expect(ExportActionsBodySchema.parse({ include: ['match_score'] }).include).toEqual([
      'match_score',
    ]);
  });
});
