import { describe, expect, it } from 'vitest';
import {
  mergeItemStateWithPrivate,
  mergeMasksIntoPublic,
  projectPrivateStateForSchema,
  splitItemStateByPrivacy,
} from '../item_state_privacy';

const flatSchema = {
  properties: {
    name: { type: 'string' },
    phone: { type: 'string', private: true },
  },
};

describe('splitItemStateByPrivacy — flat fields', () => {
  it('routes a `private: true` field to privateState and the rest to publicState', () => {
    const result = splitItemStateByPrivacy(flatSchema, { name: 'Asha', phone: '+919876543210' });

    expect(result.publicState).toEqual({ name: 'Asha' });
    expect(result.privateState).toEqual({ phone: '+919876543210' });
  });

  it('treats `private: false` and an absent marker as public', () => {
    const schema = {
      properties: { a: { private: false }, b: { type: 'string' } },
    };

    expect(splitItemStateByPrivacy(schema, { a: 1, b: 2 })).toEqual({
      publicState: { a: 1, b: 2 },
      privateState: {},
    });
  });

  it('treats a truthy-but-not-true private marker as public (strict === true)', () => {
    const schema = { properties: { a: { private: 'yes' } } };

    expect(splitItemStateByPrivacy(schema, { a: 1 })).toEqual({
      publicState: { a: 1 },
      privateState: {},
    });
  });

  it('keeps undeclared keys public', () => {
    const result = splitItemStateByPrivacy(flatSchema, { name: 'Asha', rogue: 'value' });

    expect(result.publicState).toEqual({ name: 'Asha', rogue: 'value' });
    expect(result.privateState).toEqual({});
  });

  it('keeps a private field private even when its value is null', () => {
    const result = splitItemStateByPrivacy(flatSchema, { phone: null });

    expect(result.publicState).toEqual({});
    expect(result.privateState).toEqual({ phone: null });
  });

  it('treats a schema without `properties` as all-public', () => {
    expect(splitItemStateByPrivacy({}, { a: 1 })).toEqual({
      publicState: { a: 1 },
      privateState: {},
    });
  });

  it('returns two empty objects for an empty state', () => {
    expect(splitItemStateByPrivacy(flatSchema, {})).toEqual({
      publicState: {},
      privateState: {},
    });
  });
});

describe('splitItemStateByPrivacy — nested objects', () => {
  const schema = {
    properties: {
      contact: {
        properties: {
          city: { type: 'string' },
          email: { type: 'string', private: true },
        },
      },
    },
  };

  it('splits a nested object into both halves', () => {
    const result = splitItemStateByPrivacy(schema, {
      contact: { city: 'Pune', email: 'a@b.com' },
    });

    expect(result.publicState).toEqual({ contact: { city: 'Pune' } });
    expect(result.privateState).toEqual({ contact: { email: 'a@b.com' } });
  });

  it('omits the parent key from publicState when every nested field is private', () => {
    const result = splitItemStateByPrivacy(schema, { contact: { email: 'a@b.com' } });

    expect(result.publicState).toEqual({});
    expect(result.privateState).toEqual({ contact: { email: 'a@b.com' } });
  });

  it('omits the parent key from privateState when no nested field is private', () => {
    const result = splitItemStateByPrivacy(schema, { contact: { city: 'Pune' } });

    expect(result.publicState).toEqual({ contact: { city: 'Pune' } });
    expect(result.privateState).toEqual({});
  });

  it('sends the whole subtree private when the parent object itself is private', () => {
    const parentPrivate = {
      properties: {
        contact: { private: true, properties: { city: { type: 'string' } } },
      },
    };

    const result = splitItemStateByPrivacy(parentPrivate, { contact: { city: 'Pune' } });
    expect(result.publicState).toEqual({});
    expect(result.privateState).toEqual({ contact: { city: 'Pune' } });
  });

  it('does not recurse when the schema node is not an object (value stays public)', () => {
    const result = splitItemStateByPrivacy(
      { properties: { contact: 'not-a-schema' } },
      { contact: { email: 'a@b.com' } },
    );

    expect(result.publicState).toEqual({ contact: { email: 'a@b.com' } });
    expect(result.privateState).toEqual({});
  });
});

describe('splitItemStateByPrivacy — arrays', () => {
  const schema = {
    properties: {
      refs: {
        type: 'array',
        items: {
          properties: {
            org: { type: 'string' },
            phone: { type: 'string', private: true },
          },
        },
      },
    },
  };

  it('splits an array of objects index-aligned', () => {
    const result = splitItemStateByPrivacy(schema, {
      refs: [
        { org: 'Acme', phone: '+911111111111' },
        { org: 'Beta', phone: '+912222222222' },
      ],
    });

    expect(result.publicState).toEqual({ refs: [{ org: 'Acme' }, { org: 'Beta' }] });
    expect(result.privateState).toEqual({
      refs: [{ phone: '+911111111111' }, { phone: '+912222222222' }],
    });
  });

  it('drops the private array entirely when no element contributed a private value', () => {
    const result = splitItemStateByPrivacy(schema, { refs: [{ org: 'Acme' }] });

    expect(result.publicState).toEqual({ refs: [{ org: 'Acme' }] });
    expect(result.privateState).toEqual({});
  });

  it('pads non-object elements with null in the private array to keep indexes aligned', () => {
    const result = splitItemStateByPrivacy(schema, {
      refs: ['plain-string', { org: 'Acme', phone: '+911111111111' }],
    });

    expect(result.publicState).toEqual({ refs: ['plain-string', { org: 'Acme' }] });
    expect(result.privateState).toEqual({ refs: [null, { phone: '+911111111111' }] });
  });

  it('omits an empty public array (length 0 is not written)', () => {
    const result = splitItemStateByPrivacy(schema, { refs: [] });

    expect(result.publicState).toEqual({});
    expect(result.privateState).toEqual({});
  });

  it('keeps the whole array public when the array schema declares no object `items`', () => {
    const noItems = { properties: { tags: { type: 'array' } } };

    const result = splitItemStateByPrivacy(noItems, { tags: ['a', 'b'] });
    expect(result.publicState).toEqual({ tags: ['a', 'b'] });
    expect(result.privateState).toEqual({});
  });

  it('sends the whole array private when the array field itself is private', () => {
    const privateArray = {
      properties: { refs: { private: true, items: { properties: { org: {} } } } },
    };

    const result = splitItemStateByPrivacy(privateArray, { refs: [{ org: 'Acme' }] });
    expect(result.publicState).toEqual({});
    expect(result.privateState).toEqual({ refs: [{ org: 'Acme' }] });
  });
});

describe('mergeItemStateWithPrivate', () => {
  it('adds private keys onto the public mirror', () => {
    expect(mergeItemStateWithPrivate({ name: 'Asha' }, { phone: '+91' })).toEqual({
      name: 'Asha',
      phone: '+91',
    });
  });

  it('lets the private value win a key collision', () => {
    expect(mergeItemStateWithPrivate({ phone: '+91XXXXXX' }, { phone: '+919876543210' })).toEqual({
      phone: '+919876543210',
    });
  });

  it('deep-merges nested objects rather than replacing them', () => {
    expect(
      mergeItemStateWithPrivate({ contact: { city: 'Pune' } }, { contact: { email: 'a@b.com' } }),
    ).toEqual({ contact: { city: 'Pune', email: 'a@b.com' } });
  });

  it('merges arrays index-aligned, keeping the public entry where the private one is null', () => {
    const merged = mergeItemStateWithPrivate(
      { refs: [{ org: 'Acme' }, 'plain'] },
      { refs: [{ phone: '+91' }, null] },
    );

    expect(merged).toEqual({ refs: [{ org: 'Acme', phone: '+91' }, 'plain'] });
  });

  it('keeps the public entry when the private array is shorter', () => {
    const merged = mergeItemStateWithPrivate(
      { refs: [{ org: 'Acme' }, { org: 'Beta' }] },
      { refs: [{ phone: '+91' }] },
    );

    expect(merged).toEqual({ refs: [{ org: 'Acme', phone: '+91' }, { org: 'Beta' }] });
  });

  it('ignores extra private array entries beyond the public array length', () => {
    const merged = mergeItemStateWithPrivate({ refs: [{ org: 'Acme' }] }, { refs: [{}, {}] });

    expect(merged).toEqual({ refs: [{ org: 'Acme' }] });
  });

  it('replaces (not merges) when only one side is an array', () => {
    expect(mergeItemStateWithPrivate({ refs: { a: 1 } }, { refs: [1, 2] })).toEqual({
      refs: [1, 2],
    });
  });

  it('does not mutate its inputs', () => {
    const publicState = { contact: { city: 'Pune' } };
    const privateState = { contact: { email: 'a@b.com' } };

    mergeItemStateWithPrivate(publicState, privateState);
    expect(publicState).toEqual({ contact: { city: 'Pune' } });
    expect(privateState).toEqual({ contact: { email: 'a@b.com' } });
  });

  it('mergeMasksIntoPublic is the same merge under a different name', () => {
    const publicState = { contact: { city: 'Pune' }, phone: '+91XXXX' };
    const masked = { contact: { email: 'a***@b.com' }, phone: '+91XXXXXX10' };

    expect(mergeMasksIntoPublic(publicState, masked)).toEqual(
      mergeItemStateWithPrivate(publicState, masked),
    );
  });

  it('round-trips a split state back to the original', () => {
    const schema = {
      properties: {
        name: {},
        phone: { private: true },
        contact: { properties: { city: {}, email: { private: true } } },
        refs: { items: { properties: { org: {}, phone: { private: true } } } },
      },
    };
    const state = {
      name: 'Asha',
      phone: '+919876543210',
      contact: { city: 'Pune', email: 'a@b.com' },
      refs: [{ org: 'Acme', phone: '+911111111111' }],
    };

    const { publicState, privateState } = splitItemStateByPrivacy(schema, state);
    expect(mergeItemStateWithPrivate(publicState, privateState)).toEqual(state);
  });
});

describe('projectPrivateStateForSchema', () => {
  const schema = {
    properties: {
      phone: { private: true },
      contact: { properties: { email: { private: true } } },
      refs: { items: { properties: { phone: { private: true } } } },
    },
  };

  it('keeps only keys declared in the schema', () => {
    const projected = projectPrivateStateForSchema(schema, {
      phone: '+91',
      stale_field: 'dropped',
    });

    expect(projected).toEqual({ phone: '+91' });
  });

  it('skips declared keys that are absent from the state', () => {
    expect(projectPrivateStateForSchema(schema, {})).toEqual({});
  });

  it('preserves an explicit undefined-valued declared key as present', () => {
    const projected = projectPrivateStateForSchema(schema, { phone: undefined });

    expect(Object.hasOwn(projected, 'phone')).toBe(true);
    expect(projected.phone).toBeUndefined();
  });

  it('projects nested objects and drops nested keys the schema no longer declares', () => {
    const projected = projectPrivateStateForSchema(schema, {
      contact: { email: 'a@b.com', removed: 'x' },
    });

    expect(projected).toEqual({ contact: { email: 'a@b.com' } });
  });

  it('omits a nested object that projects to nothing', () => {
    const projected = projectPrivateStateForSchema(schema, { contact: { removed: 'x' } });

    expect(projected).toEqual({});
  });

  it('projects array element objects through the items schema', () => {
    const projected = projectPrivateStateForSchema(schema, {
      refs: [{ phone: '+91', removed: 'x' }, null, 'scalar'],
    });

    expect(projected).toEqual({ refs: [{ phone: '+91' }, null, 'scalar'] });
  });

  it('keeps an empty array as an empty array (not omitted)', () => {
    expect(projectPrivateStateForSchema(schema, { refs: [] })).toEqual({ refs: [] });
  });

  it('passes an array straight through when the items schema is not an object', () => {
    const noItems = { properties: { tags: { type: 'array' } } };

    expect(projectPrivateStateForSchema(noItems, { tags: ['a'] })).toEqual({ tags: ['a'] });
  });

  it('returns {} for a schema with no properties', () => {
    expect(projectPrivateStateForSchema({}, { phone: '+91' })).toEqual({});
  });
});
