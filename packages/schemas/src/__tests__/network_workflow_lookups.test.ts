import { describe, it, expect } from 'vitest';
import {
  parseNetworkConfigDocument,
  getActionInteraction,
  getDomainItemSchema,
  getDomainItemTypes,
  getDomainMinimumCacheTtlSeconds,
  getInstanceCustomItemSchemaUrl,
  validateAgainstJsonSchema,
} from '../network_workflow';

const defaultTail = [{ status: 'new', when: 'default' }];

const profileSchema = {
  type: 'object',
  properties: {
    full_name: { type: 'string' },
    city: { type: 'string' },
  },
  required: ['full_name'],
  additionalProperties: false,
};

const config = parseNetworkConfigDocument({
  id: 'yellow_dot',
  domains: [
    {
      id: 'student',
      item_schemas: { 'profile_1.0': profileSchema, 'resume_1.0': { type: 'object' } },
      status_rules: defaultTail,
    },
    {
      id: 'college',
      minimum_cache_ttl_seconds: 900,
      default_item_schemas: { 'profile_1.0': { type: 'object', title: 'default' } },
      item_schemas: { 'profile_1.0': { type: 'object', title: 'override' } },
      status_rules: defaultTail,
    },
  ],
  instances: [
    {
      domain_id: 'student',
      instance_url: 'https://student.example.com',
      schema_url: 'https://schemas.example.com/student.json',
      custom_item_schema_urls: { 'resume_1.0': 'https://schemas.example.com/resume.json' },
    },
    { domain_id: 'college', instance_url: 'https://college.example.com' },
  ],
  actions: {
    apply: {
      interactions: [
        {
          from_domain: 'student',
          from_items: ['profile_1.0'],
          to_domain: 'college',
          requirement_schema: { type: 'object' },
        },
        {
          from_network: 'blue_dot',
          from_domain: 'seeker',
          to_domain: 'college',
          requirement_schema: { type: 'object', title: 'cross-network' },
        },
      ],
    },
  },
});

describe('getActionInteraction', () => {
  it('resolves an interaction, defaulting omitted networks to the config id', () => {
    const interaction = getActionInteraction(config, {
      actionType: 'apply',
      fromNetwork: 'yellow_dot',
      fromDomain: 'student',
      fromItemType: 'profile_1.0',
      toNetwork: 'yellow_dot',
      toDomain: 'college',
    });
    expect(interaction.from_items).toEqual(['profile_1.0']);
  });

  it('honours an explicit from_network instead of the config id', () => {
    const interaction = getActionInteraction(config, {
      actionType: 'apply',
      fromNetwork: 'blue_dot',
      fromDomain: 'seeker',
      toNetwork: 'yellow_dot',
      toDomain: 'college',
    });
    expect(interaction.requirement_schema.title).toBe('cross-network');
  });

  it('throws when the action type is not declared on the network', () => {
    expect(() =>
      getActionInteraction(config, {
        actionType: 'endorse',
        fromNetwork: 'yellow_dot',
        fromDomain: 'student',
        toNetwork: 'yellow_dot',
        toDomain: 'college',
      }),
    ).toThrow('Action "endorse" is not defined for network "yellow_dot".');
  });

  it('throws when no interaction matches the direction', () => {
    expect(() =>
      getActionInteraction(config, {
        actionType: 'apply',
        fromNetwork: 'yellow_dot',
        fromDomain: 'college',
        toNetwork: 'yellow_dot',
        toDomain: 'student',
      }),
    ).toThrow(
      'Action "apply" is not allowed from "yellow_dot/college" to "yellow_dot/student".',
    );
  });

  it('rejects a from_item_type outside the interaction allowlist and names it in the error', () => {
    expect(() =>
      getActionInteraction(config, {
        actionType: 'apply',
        fromNetwork: 'yellow_dot',
        fromDomain: 'student',
        fromItemType: 'resume_1.0',
        toNetwork: 'yellow_dot',
        toDomain: 'college',
        toItemType: 'profile_1.0',
      }),
    ).toThrow(
      'from "yellow_dot/student/resume_1.0" to "yellow_dot/college/profile_1.0"',
    );
  });

  it('treats an empty allowlist as "any item type" on that side', () => {
    // to_items is empty on the student→college interaction, so any toItemType matches.
    const interaction = getActionInteraction(config, {
      actionType: 'apply',
      fromNetwork: 'yellow_dot',
      fromDomain: 'student',
      fromItemType: 'profile_1.0',
      toNetwork: 'yellow_dot',
      toDomain: 'college',
      toItemType: 'anything_9.9',
    });
    expect(interaction.to_domain).toBe('college');
  });

  it('rejects an absent item type when the interaction declares a from_items allowlist', () => {
    // from_items: ['profile_1.0'] is non-empty, so an undefined fromItemType
    // cannot satisfy it — the omitted type is left out of the error string.
    expect(() =>
      getActionInteraction(config, {
        actionType: 'apply',
        fromNetwork: 'yellow_dot',
        fromDomain: 'student',
        toNetwork: 'yellow_dot',
        toDomain: 'college',
      }),
    ).toThrow(
      'Action "apply" is not allowed from "yellow_dot/student" to "yellow_dot/college".',
    );
  });
});

describe('getDomainItemSchema', () => {
  it('returns the schema for a declared item type', () => {
    expect(getDomainItemSchema(config, 'student', 'profile_1.0')).toEqual(profileSchema);
  });

  it('lets item_schemas override default_item_schemas for the same key', () => {
    expect(getDomainItemSchema(config, 'college', 'profile_1.0')).toEqual({
      type: 'object',
      title: 'override',
    });
  });

  it('throws for an unknown domain', () => {
    expect(() => getDomainItemSchema(config, 'ghost', 'profile_1.0')).toThrow(
      'Domain "ghost" is not defined for network "yellow_dot".',
    );
  });

  it('throws for an unknown item type in a known domain', () => {
    expect(() => getDomainItemSchema(config, 'student', 'nope_1.0')).toThrow(
      'Item type "nope_1.0" is not defined for domain "student" in network "yellow_dot".',
    );
  });
});

describe('getDomainItemTypes', () => {
  it('lists every merged item schema key for the domain', () => {
    expect(getDomainItemTypes(config, 'student').sort()).toEqual([
      'profile_1.0',
      'resume_1.0',
    ]);
  });

  it('throws for an unknown domain', () => {
    expect(() => getDomainItemTypes(config, 'ghost')).toThrow(
      'Domain "ghost" is not defined for network "yellow_dot".',
    );
  });
});

describe('getDomainMinimumCacheTtlSeconds', () => {
  it('returns the declared ttl', () => {
    expect(getDomainMinimumCacheTtlSeconds(config, 'college')).toBe(900);
  });

  it('falls back to the 300s schema default when unset', () => {
    expect(getDomainMinimumCacheTtlSeconds(config, 'student')).toBe(300);
  });

  it('throws for an unknown domain', () => {
    expect(() => getDomainMinimumCacheTtlSeconds(config, 'ghost')).toThrow(
      'Domain "ghost" is not defined for network "yellow_dot".',
    );
  });
});

describe('getInstanceCustomItemSchemaUrl', () => {
  it('maps a legacy schema_url onto the "profile" key', () => {
    expect(
      getInstanceCustomItemSchemaUrl(config, {
        domain: 'student',
        instanceUrl: 'https://student.example.com',
        itemType: 'profile',
      }),
    ).toBe('https://schemas.example.com/student.json');
  });

  it('returns an explicit per-item-type override', () => {
    expect(
      getInstanceCustomItemSchemaUrl(config, {
        domain: 'student',
        instanceUrl: 'https://student.example.com',
        itemType: 'resume_1.0',
      }),
    ).toBe('https://schemas.example.com/resume.json');
  });

  it('returns null when the instance has no url for that item type', () => {
    expect(
      getInstanceCustomItemSchemaUrl(config, {
        domain: 'college',
        instanceUrl: 'https://college.example.com',
        itemType: 'profile',
      }),
    ).toBeNull();
  });

  it('returns null when no instance matches the domain/url pair', () => {
    expect(
      getInstanceCustomItemSchemaUrl(config, {
        domain: 'student',
        instanceUrl: 'https://other.example.com',
        itemType: 'profile',
      }),
    ).toBeNull();
  });
});

describe('validateAgainstJsonSchema', () => {
  it('returns silently for a valid payload', () => {
    expect(() =>
      validateAgainstJsonSchema(profileSchema, { full_name: 'Asha', city: 'Pune' }, 'item_state'),
    ).not.toThrow();
  });

  it('throws an "Invalid <label>" error listing every ajv message', () => {
    let message = '';
    try {
      validateAgainstJsonSchema(profileSchema, { city: 42, extra: true }, 'item_state');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Invalid item_state:');
    expect(message).toContain("must have required property 'full_name'");
    expect(message).toContain('must be string');
    expect(message).toContain('must NOT have additional properties');
  });

  it('rejects extra properties by default but accepts them with allowAdditionalProperties', () => {
    const payload = { full_name: 'Asha', surprise: 1 };
    expect(() => validateAgainstJsonSchema(profileSchema, payload, 'item_state')).toThrow(
      /must NOT have additional properties/,
    );
    expect(() =>
      validateAgainstJsonSchema(profileSchema, payload, 'item_state', {
        allowAdditionalProperties: true,
      }),
    ).not.toThrow();
  });

  it('relaxes unevaluatedProperties:false as well, recursively through nested objects and arrays', () => {
    const nested = {
      type: 'object',
      unevaluatedProperties: false,
      properties: {
        profile: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
        tags: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } },
        },
      },
    };
    const payload = {
      profile: { a: 'x', deep_extra: 1 },
      tags: [{ b: 'y', array_extra: 2 }],
      top_extra: 3,
    };
    expect(() => validateAgainstJsonSchema(nested, payload, 'requirement')).toThrow(
      /Invalid requirement:/,
    );
    expect(() =>
      validateAgainstJsonSchema(nested, payload, 'requirement', {
        allowAdditionalProperties: true,
      }),
    ).not.toThrow();
  });

  it('ignoredKeys strips the key from both the required list and the payload', () => {
    // `full_name` is required and `additionalProperties:false` would reject a
    // stray key — ignoring it must drop it from the requirement AND the payload.
    expect(() =>
      validateAgainstJsonSchema(profileSchema, { city: 'Pune' }, 'item_state'),
    ).toThrow(/must have required property 'full_name'/);

    expect(() =>
      validateAgainstJsonSchema(profileSchema, { city: 'Pune' }, 'item_state', {
        ignoredKeys: ['full_name'],
      }),
    ).not.toThrow();

    // The ignored key is removed from the payload, so a bad value for it passes.
    expect(() =>
      validateAgainstJsonSchema(profileSchema, { city: 'Pune', full_name: 99 }, 'item_state', {
        ignoredKeys: ['full_name'],
      }),
    ).not.toThrow();
  });

  it('strips ignoredKeys from nested required arrays too', () => {
    const nested = {
      type: 'object',
      properties: {
        inner: { type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'] },
      },
      required: ['inner'],
    };
    expect(() => validateAgainstJsonSchema(nested, { inner: {} }, 'requirement')).toThrow(
      /must have required property 'secret'/,
    );
    expect(() =>
      validateAgainstJsonSchema(nested, { inner: {} }, 'requirement', {
        ignoredKeys: ['secret'],
      }),
    ).not.toThrow();
  });

  it('leaves a non-object payload untouched when ignoredKeys is set', () => {
    expect(() =>
      validateAgainstJsonSchema({ type: 'string' }, 'plain', 'item_state', {
        ignoredKeys: ['anything'],
      }),
    ).not.toThrow();
    expect(() =>
      validateAgainstJsonSchema({ type: 'string' }, 7, 'item_state', {
        ignoredKeys: ['anything'],
      }),
    ).toThrow(/Invalid item_state: must be string/);
  });

  it('keeps a non-string entry in a required array, so ajv rejects the schema itself', () => {
    // The ignoredKeys filter only drops string entries; a numeric one survives
    // and ajv.compile throws a raw schema-invalid error that is NOT wrapped in
    // the "Invalid <label>: ..." message (the wrap only covers payload errors).
    const odd = { type: 'object', properties: { a: { type: 'string' } }, required: [123] };
    expect(() =>
      validateAgainstJsonSchema(odd, { a: 'x' }, 'item_state', { ignoredKeys: ['a'] }),
    ).toThrow('schema is invalid: data/required/0 must be string');
  });

  it('preserves array-valued schema keywords (enum) through the rewrite', () => {
    const enumSchema = {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'closed'] } },
      required: ['status'],
      additionalProperties: false,
    };
    expect(() =>
      validateAgainstJsonSchema(enumSchema, { status: 'open' }, 'event', {
        allowAdditionalProperties: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateAgainstJsonSchema(enumSchema, { status: 'nope' }, 'event', {
        allowAdditionalProperties: true,
      }),
    ).toThrow(/Invalid event:/);
  });
});
