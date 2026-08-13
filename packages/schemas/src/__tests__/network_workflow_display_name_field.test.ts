import { describe, it, expect } from 'vitest';
import { NetworkConfigSchema, parseNetworkConfigDocument } from '../network_workflow';

const defaultTail = [{ status: 'new', when: 'default' }];

function configWithSchema(itemSchema: Record<string, unknown>) {
  return {
    id: 'yellow_dot',
    domains: [{ id: 'student', item_schemas: { 'profile_1.0': itemSchema }, status_rules: defaultTail }],
    actions: {},
  };
}

const expectedPath = ['domains', 0, 'item_schemas', 'profile_1.0', 'display_name_field'];

describe('display_name_field validation', () => {
  it('accepts a schema with no display_name_field at all', () => {
    expect(
      NetworkConfigSchema.safeParse(
        configWithSchema({ type: 'object', properties: { full_name: { type: 'string' } } }),
      ).success,
    ).toBe(true);
  });

  it('accepts a display_name_field pointing at a public string property', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({
        type: 'object',
        display_name_field: 'full_name',
        properties: { full_name: { type: 'string' } },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a non-string display_name_field', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({
        type: 'object',
        display_name_field: 42,
        properties: { full_name: { type: 'string' } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('display_name_field must be a string');
      expect(result.error.issues[0].path).toEqual(expectedPath);
    }
  });

  it('rejects a display_name_field naming a property that does not exist', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({
        type: 'object',
        display_name_field: 'nickname',
        properties: { full_name: { type: 'string' } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'display_name_field "nickname" does not exist in properties',
      );
      expect(result.error.issues[0].path).toEqual(expectedPath);
    }
  });

  it('rejects a display_name_field when the schema declares no properties at all', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({ type: 'object', display_name_field: 'full_name' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('does not exist in properties');
    }
  });

  it('rejects a display_name_field pointing at a private property', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({
        type: 'object',
        display_name_field: 'legal_name',
        properties: { legal_name: { type: 'string', private: true } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'display_name_field "legal_name" points at a private property; pick a non-private field',
      );
    }
  });

  it('rejects a display_name_field pointing at a non-string property', () => {
    const result = NetworkConfigSchema.safeParse(
      configWithSchema({
        type: 'object',
        display_name_field: 'graduation_year',
        properties: { graduation_year: { type: 'number' } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'display_name_field "graduation_year" must point at a property of type "string"',
      );
    }
  });

  it('validates a display_name_field inherited from default_item_schemas after the merge', () => {
    const result = NetworkConfigSchema.safeParse({
      id: 'yellow_dot',
      domains: [
        {
          id: 'student',
          default_item_schemas: {
            'profile_1.0': {
              type: 'object',
              display_name_field: 'ghost',
              properties: { full_name: { type: 'string' } },
            },
          },
          status_rules: defaultTail,
        },
      ],
      actions: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'display_name_field "ghost" does not exist in properties',
      );
    }
  });
});

describe('status_rules tail rule', () => {
  it('requires the last rule to be { when: "default" }', () => {
    const result = NetworkConfigSchema.safeParse({
      id: 'yellow_dot',
      domains: [
        {
          id: 'student',
          status_rules: [
            { status: 'new', when: 'default' },
            { status: 'active', when: { item_age_days: { lt: 30 } } },
          ],
        },
      ],
      actions: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'status_rules must end with a `{ when: "default" }` tail rule',
      );
      expect(result.error.issues[0].path).toEqual(['domains', 0, 'status_rules', 1, 'when']);
    }
  });

  it('accepts a default tail preceded by predicate rules', () => {
    expect(
      parseNetworkConfigDocument({
        id: 'yellow_dot',
        domains: [
          {
            id: 'student',
            status_rules: [
              { status: 'active', when: { count: { buckets: ['create'], gte: 1 } } },
              { status: 'at_risk', when: { any: [{ days_since_last: { buckets: ['accept'], gt: 30 } }] } },
              { status: 'new', when: 'default' },
            ],
          },
        ],
        actions: {},
      }).domains[0].status_rules,
    ).toHaveLength(3);
  });

  // DEFECT (pinned, not endorsed): `status_rules` carries `.min(1)`, but zod v4
  // still runs the domain-level superRefine after that inner check fails, and
  // the refine dereferences `last.when` on the (undefined) tail element. So an
  // empty `status_rules` array escapes as a thrown TypeError instead of a
  // ZodError — `safeParse` does not shield the caller from it. The fix is
  // `last?.when !== 'default'` in network_workflow.ts (~line 126); until then a
  // network.json with `status_rules: []` crashes config load rather than
  // reporting "must contain at least 1 element".
  it('crashes instead of returning a ZodError for an empty status_rules array', () => {
    expect(() =>
      NetworkConfigSchema.safeParse({
        id: 'yellow_dot',
        domains: [{ id: 'student', status_rules: [] }],
        actions: {},
      }),
    ).toThrow(TypeError);
  });

  it('rejects a status_rules entry with a non-canonical status', () => {
    expect(
      NetworkConfigSchema.safeParse({
        id: 'yellow_dot',
        domains: [{ id: 'student', status_rules: [{ status: 'archived', when: 'default' }] }],
        actions: {},
      }).success,
    ).toBe(false);
  });

  it('rejects a predicate referencing a non-canonical bucket', () => {
    expect(
      NetworkConfigSchema.safeParse({
        id: 'yellow_dot',
        domains: [
          {
            id: 'student',
            status_rules: [
              { status: 'active', when: { count: { buckets: ['endorse'], gte: 1 } } },
              { status: 'new', when: 'default' },
            ],
          },
        ],
        actions: {},
      }).success,
    ).toBe(false);
  });
});
