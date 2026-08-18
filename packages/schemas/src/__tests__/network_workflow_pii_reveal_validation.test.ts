import { describe, it, expect } from 'vitest';
import { NetworkActionInteractionSchema } from '../network_workflow';

const base = {
  from_domain: 'student',
  to_domain: 'college',
  requirement_schema: { type: 'object' },
};

const statusEnumSchema = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['created', 'accepted', 'rejected'] } },
};

const NO_ENUM_MESSAGE =
  'reveals_pii_on_status requires event_schema.properties.status.enum to be defined';

describe('reveals_pii_on_status validation', () => {
  it('accepts an interaction with no reveals_pii_on_status and defaults it to []', () => {
    const result = NetworkActionInteractionSchema.safeParse({ ...base });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reveals_pii_on_status).toEqual([]);
  });

  it('accepts statuses present in event_schema.properties.status.enum', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: statusEnumSchema,
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects reveals_pii_on_status with no event_schema at all', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'reveals_pii_on_status requires event_schema with a status.enum to validate against',
      );
      expect(result.error.issues[0].path).toEqual(['reveals_pii_on_status']);
    }
  });

  it('rejects an event_schema with no properties key', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object' },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(NO_ENUM_MESSAGE);
  });

  it('rejects an event_schema whose properties is not an object', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object', properties: 'nope' },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(NO_ENUM_MESSAGE);
  });

  it('rejects an event_schema whose properties omits status', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object', properties: { note: { type: 'string' } } },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(NO_ENUM_MESSAGE);
  });

  it('rejects a status property that is not an object', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object', properties: { status: 'string' } },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(NO_ENUM_MESSAGE);
  });

  it('rejects a status property whose enum is not an array', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object', properties: { status: { type: 'string', enum: 'accepted' } } },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(NO_ENUM_MESSAGE);
  });

  it('reports one issue per status missing from the enum', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: statusEnumSchema,
      reveals_pii_on_status: ['accepted', 'withdrawn', 'expired'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(2);
      expect(result.error.issues.map((i) => i.message)).toEqual([
        'reveals_pii_on_status value "withdrawn" is not in event_schema.properties.status.enum',
        'reveals_pii_on_status value "expired" is not in event_schema.properties.status.enum',
      ]);
    }
  });

  it('ignores non-string enum members when checking membership', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      event_schema: { type: 'object', properties: { status: { enum: ['accepted', 7, null] } } },
      reveals_pii_on_status: ['accepted'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string entry in reveals_pii_on_status', () => {
    expect(
      NetworkActionInteractionSchema.safeParse({
        ...base,
        event_schema: statusEnumSchema,
        reveals_pii_on_status: [''],
      }).success,
    ).toBe(false);
  });
});
