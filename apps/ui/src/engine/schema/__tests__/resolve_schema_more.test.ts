import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import {
  resolveJsonPointer,
  extractSchema,
  resolveRefString,
  resolveNetworkRefs,
  resolveRefs,
  mergeAllOf,
} from '../resolve-schema';
import {
  loadSchema,
  clearSchemaCache,
  getCachedSchema,
  setCachedSchema,
} from '../schema-loader';
import type { DotProfileSchema, SchemaInput } from '../../types';

/** Minimal Response stand-in — only `ok`/`status`/`json()` are used by the SUT. */
function jsonResponse(
  data: unknown,
  init?: { ok?: boolean; status?: number }
): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

const fetchMock = vi.fn(
  (_url: string): Promise<Response> => Promise.resolve(jsonResponse({}))
);

/** Serves a fixed url → document map, failing loudly on an unexpected url. */
function serve(docs: Record<string, unknown>): void {
  fetchMock.mockImplementation((url: string) => {
    if (url in docs) return Promise.resolve(jsonResponse(docs[url]));
    return Promise.resolve(jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));
  });
}

/** The urls fetch was called with, in order. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  clearSchemaCache();
  fetchMock.mockClear();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveJsonPointer', () => {
  const doc = {
    definitions: {
      student: { type: 'object', title: 'Student' },
      'a/b': { type: 'string' },
      'm~n': { type: 'boolean' },
    },
    domains: [{ id: 'student' }, { id: 'college' }],
    nothing: null,
    scalar: 42,
  };

  it('walks nested object keys', () => {
    expect(resolveJsonPointer(doc, '#/definitions/student')).toEqual({
      type: 'object',
      title: 'Student',
    });
  });

  it('indexes into arrays', () => {
    expect(resolveJsonPointer(doc, '#/domains/1')).toEqual({ id: 'college' });
  });

  it('un-escapes ~1 as "/" and ~0 as "~" in key segments', () => {
    expect(resolveJsonPointer(doc, '#/definitions/a~1b')).toEqual({ type: 'string' });
    expect(resolveJsonPointer(doc, '#/definitions/m~0n')).toEqual({ type: 'boolean' });
  });

  it('rejects a pointer that is not rooted at "#/"', () => {
    expect(() => resolveJsonPointer(doc, 'definitions/student')).toThrow(
      /Invalid JSON Pointer: definitions\/student/
    );
    expect(() => resolveJsonPointer(doc, '/definitions/student')).toThrow(
      /Invalid JSON Pointer/
    );
  });

  it('rejects the bare root pointer "#" despite the dead `pointer === "#"` branch below the guard', () => {
    // The `if (pointer === '#') return doc` line is unreachable: the
    // startsWith('#/') guard above it throws first. Asserting real behaviour.
    expect(() => resolveJsonPointer(doc, '#')).toThrow(/Invalid JSON Pointer: #/);
  });

  it('reports the missing key when a segment is absent', () => {
    expect(() => resolveJsonPointer(doc, '#/definitions/teacher')).toThrow(
      /Key "teacher" not found/
    );
  });

  it('reports an out-of-range or non-numeric array index', () => {
    expect(() => resolveJsonPointer(doc, '#/domains/9')).toThrow(
      /Invalid array index "9"/
    );
    expect(() => resolveJsonPointer(doc, '#/domains/first')).toThrow(
      /Invalid array index "first"/
    );
    expect(() => resolveJsonPointer(doc, '#/domains/-1')).toThrow(
      /Invalid array index "-1"/
    );
  });

  it('reports null/undefined encountered mid-walk', () => {
    expect(() => resolveJsonPointer(doc, '#/nothing/deeper')).toThrow(
      /null\/undefined at segment "deeper"/
    );
    expect(() => resolveJsonPointer(undefined, '#/anything')).toThrow(
      /null\/undefined at segment "anything"/
    );
  });

  it('reports a primitive encountered mid-walk', () => {
    expect(() => resolveJsonPointer(doc, '#/scalar/deeper')).toThrow(
      /primitive at segment "deeper"/
    );
  });
});

describe('extractSchema', () => {
  const inner: RJSFSchema = { type: 'object', properties: { name: { type: 'string' } } };

  it('unwraps a DotProfileSchema wrapper down to its inner JSON Schema', () => {
    const wrapper: DotProfileSchema = {
      info: 'student profile',
      name: 'profile',
      version: '1.0',
      details: { dot: 'yellow_dot', domain: 'student' },
      schema_type: 'profile',
      schema: inner,
    };
    expect(extractSchema(wrapper)).toEqual(inner);
  });

  it('passes a plain schema through untouched', () => {
    expect(extractSchema(inner)).toBe(inner);
  });

  it('does not unwrap when schema_type is not "profile" or `schema` is absent', () => {
    const actionish = { schema_type: 'action', schema: inner };
    expect(extractSchema(actionish)).toBe(actionish);

    const noSchema = { schema_type: 'profile', name: 'profile' };
    expect(extractSchema(noSchema)).toBe(noSchema);
  });

  it('passes null and primitives through without throwing', () => {
    expect(extractSchema(null)).toBeNull();
    expect(extractSchema('nope')).toBe('nope');
  });
});

describe('resolveRefString', () => {
  it('prefers refMap over the network', async () => {
    const mapped = { type: 'object', title: 'from map' };
    const result = await resolveRefString('./profile.json', {
      refMap: { './profile.json': mapped },
    });
    expect(result).toEqual(mapped);
    expect(fetchedUrls()).toEqual([]);
  });

  it('fetches an absolute url as-is and caches it under the ref string', async () => {
    const doc = { type: 'object', title: 'remote' };
    serve({ 'https://cdn.example.org/profile.json': doc });

    const first = await resolveRefString('https://cdn.example.org/profile.json');
    expect(first).toEqual(doc);
    expect(getCachedSchema('https://cdn.example.org/profile.json')).toEqual(doc);

    const second = await resolveRefString('https://cdn.example.org/profile.json');
    expect(second).toEqual(doc);
    expect(fetchedUrls()).toEqual(['https://cdn.example.org/profile.json']);
  });

  it('joins a relative ref onto baseUrl, stripping a leading "./"', async () => {
    serve({ 'https://cdn.example.org/schemas/profile.json': { type: 'object' } });
    await resolveRefString('./profile.json', {
      baseUrl: 'https://cdn.example.org/schemas',
    });
    expect(fetchedUrls()).toEqual(['https://cdn.example.org/schemas/profile.json']);
  });

  it('resolves a relative ref against window.location.origin when no baseUrl is given', async () => {
    const expected = `${window.location.origin}/reference/colleges.json`;
    serve({ [expected]: { items: [] } });
    await resolveRefString('reference/colleges.json');
    expect(fetchedUrls()).toEqual([expected]);
  });

  it('throws with the HTTP status when the fetch fails, and caches nothing', async () => {
    serve({});
    await expect(
      resolveRefString('https://cdn.example.org/missing.json')
    ).rejects.toThrow(/Failed to resolve \$ref "https:\/\/cdn.example.org\/missing.json": 404/);
    expect(getCachedSchema('https://cdn.example.org/missing.json')).toBeUndefined();
  });

  it('resolves a local JSON Pointer against the supplied rootDocument', async () => {
    const root = { definitions: { student: { type: 'object', title: 'Student' } } };
    await expect(
      resolveRefString('#/definitions/student', { rootDocument: root })
    ).resolves.toEqual({ type: 'object', title: 'Student' });
    expect(fetchedUrls()).toEqual([]);
  });

  it('refuses a local JSON Pointer when no rootDocument is supplied', async () => {
    await expect(resolveRefString('#/definitions/student')).rejects.toThrow(
      /Cannot resolve local ref "#\/definitions\/student" without rootDocument/
    );
  });

  it('caches local-pointer results by pointer only, so a second rootDocument is ignored', async () => {
    const rootA = { definitions: { a: { type: 'string' } } };
    const rootB = { definitions: { a: { type: 'number' } } };

    await expect(
      resolveRefString('#/definitions/a', { rootDocument: rootA })
    ).resolves.toEqual({ type: 'string' });

    // Cache key is the bare pointer, so rootB's own definition is never read.
    await expect(
      resolveRefString('#/definitions/a', { rootDocument: rootB })
    ).resolves.toEqual({ type: 'string' });
  });

  it('serves a pre-seeded cache entry without consulting refMap or fetch', async () => {
    setCachedSchema('./profile.json', { type: 'object', title: 'seeded' });
    const result = await resolveRefString('./profile.json', {
      refMap: { './profile.json': { type: 'object', title: 'from map' } },
    });
    expect(result).toEqual({ type: 'object', title: 'seeded' });
    expect(fetchedUrls()).toEqual([]);
  });
});

describe('resolveNetworkRefs', () => {
  it('returns primitives, null and undefined unchanged', async () => {
    await expect(resolveNetworkRefs(null)).resolves.toBeNull();
    await expect(resolveNetworkRefs(7)).resolves.toBe(7);
    await expect(resolveNetworkRefs('yellow_dot')).resolves.toBe('yellow_dot');
    await expect(resolveNetworkRefs(undefined)).resolves.toBeUndefined();
  });

  it('resolves refs nested inside arrays and objects, unwrapping profile wrappers', async () => {
    const network = {
      network_id: 'yellow_dot',
      domains: [
        { id: 'student', item_schema: { $ref: './student.json' } },
        { id: 'college', item_schema: { $ref: './college.json' } },
      ],
    };
    const studentInner: RJSFSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const resolved = (await resolveNetworkRefs(network, {
      refMap: {
        './student.json': {
          schema_type: 'profile',
          name: 'student_profile',
          schema: studentInner,
        },
        './college.json': { type: 'object', properties: { city: { type: 'string' } } },
      },
    })) as {
      network_id: string;
      domains: { id: string; item_schema: RJSFSchema }[];
    };

    expect(resolved.network_id).toBe('yellow_dot');
    expect(resolved.domains[0].item_schema).toEqual(studentInner);
    expect(resolved.domains[1].item_schema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
    expect(fetchedUrls()).toEqual([]);
  });

  it('leaves local JSON Pointer nodes in place for RJSF to resolve at render time', async () => {
    const network = {
      definitions: { addr: { type: 'string' } },
      schema: {
        type: 'object',
        properties: {
          address: { $ref: '#/definitions/addr' },
          root: { $ref: '#' },
        },
      },
    };
    const resolved = (await resolveNetworkRefs(network)) as typeof network;
    expect(resolved.schema.properties.address).toEqual({ $ref: '#/definitions/addr' });
    expect(resolved.schema.properties.root).toEqual({ $ref: '#' });
    expect(fetchedUrls()).toEqual([]);
  });

  it('follows a chain of refs discovered inside a resolved document', async () => {
    serve({
      'https://cdn.example.org/a.json': {
        type: 'object',
        properties: { inner: { $ref: 'https://cdn.example.org/b.json' } },
      },
      'https://cdn.example.org/b.json': { type: 'string', title: 'Leaf' },
    });

    const resolved = (await resolveNetworkRefs({
      $ref: 'https://cdn.example.org/a.json',
    })) as RJSFSchema;

    expect(resolved).toEqual({
      type: 'object',
      properties: { inner: { type: 'string', title: 'Leaf' } },
    });
  });

  it('double-fetches a ref shared by sibling branches — the walk is concurrent, so the cache cannot dedupe in-flight requests', async () => {
    serve({ 'https://cdn.example.org/shared.json': { type: 'string' } });
    const resolved = (await resolveNetworkRefs({
      one: { $ref: 'https://cdn.example.org/shared.json' },
      two: { $ref: 'https://cdn.example.org/shared.json' },
    })) as Record<string, RJSFSchema>;

    expect(resolved.one).toEqual({ type: 'string' });
    expect(resolved.two).toEqual({ type: 'string' });
    // Siblings are walked with Promise.all, so both miss the cache before
    // either writes to it. Only a *subsequent* walk is served from cache.
    expect(fetchedUrls()).toEqual([
      'https://cdn.example.org/shared.json',
      'https://cdn.example.org/shared.json',
    ]);

    fetchMock.mockClear();
    await resolveNetworkRefs({ three: { $ref: 'https://cdn.example.org/shared.json' } });
    expect(fetchedUrls()).toEqual([]);
  });

  it('discards sibling keys that sit alongside a $ref', async () => {
    const resolved = (await resolveNetworkRefs(
      { $ref: './student.json', title: 'Sibling title', description: 'kept?' },
      { refMap: { './student.json': { type: 'object', title: 'From ref' } } }
    )) as RJSFSchema;

    expect(resolved).toEqual({ type: 'object', title: 'From ref' });
    expect(resolved.description).toBeUndefined();
  });

  it('propagates a failed ref fetch to the caller', async () => {
    serve({});
    await expect(
      resolveNetworkRefs({ domains: [{ $ref: 'https://cdn.example.org/gone.json' }] })
    ).rejects.toThrow(/Failed to resolve \$ref "https:\/\/cdn.example.org\/gone.json": 404/);
  });

  it('ignores a non-string $ref value and recurses into it instead', async () => {
    const resolved = (await resolveNetworkRefs({ $ref: { nested: 1 } })) as {
      $ref: { nested: number };
    };
    expect(resolved.$ref).toEqual({ nested: 1 });
    expect(fetchedUrls()).toEqual([]);
  });
});

describe('resolveRefs', () => {
  it('merges the ref target with sibling keys, letting siblings win', async () => {
    serve({
      'https://cdn.example.org/base.json': {
        type: 'object',
        title: 'From ref',
        properties: { a: { type: 'string' } },
      },
    });

    const resolved = await resolveRefs({
      $ref: 'https://cdn.example.org/base.json',
      title: 'Sibling wins',
    });

    expect(resolved.$ref).toBeUndefined();
    expect(resolved.title).toBe('Sibling wins');
    expect(resolved.properties).toEqual({ a: { type: 'string' } });
  });

  it('throws on a local JSON Pointer instead of resolving it', async () => {
    await expect(
      resolveRefs({ $ref: '#/definitions/student' })
    ).rejects.toThrow(/Local JSON Pointer resolution not yet supported: #\/definitions\/student/);
    expect(fetchedUrls()).toEqual([]);
  });

  it('resolves refs inside properties, items and the composition keywords', async () => {
    serve({
      'https://cdn.example.org/name.json': { type: 'string', title: 'Name' },
      'https://cdn.example.org/tag.json': { type: 'string', title: 'Tag' },
      'https://cdn.example.org/one.json': { type: 'number', title: 'One' },
      'https://cdn.example.org/any.json': { type: 'boolean', title: 'Any' },
      'https://cdn.example.org/all.json': { type: 'object', title: 'All' },
    });

    const resolved = await resolveRefs({
      type: 'object',
      properties: {
        name: { $ref: 'https://cdn.example.org/name.json' },
        tags: { type: 'array', items: { $ref: 'https://cdn.example.org/tag.json' } },
      },
      allOf: [{ $ref: 'https://cdn.example.org/all.json' }],
      oneOf: [{ $ref: 'https://cdn.example.org/one.json' }],
      anyOf: [{ $ref: 'https://cdn.example.org/any.json' }],
    });

    const props = resolved.properties as Record<string, RJSFSchema>;
    expect(props.name).toEqual({ type: 'string', title: 'Name' });
    expect(props.tags.items).toEqual({ type: 'string', title: 'Tag' });
    expect(resolved.allOf).toEqual([{ type: 'object', title: 'All' }]);
    expect(resolved.oneOf).toEqual([{ type: 'number', title: 'One' }]);
    expect(resolved.anyOf).toEqual([{ type: 'boolean', title: 'Any' }]);
  });

  it('does not mutate the input schema', async () => {
    serve({ 'https://cdn.example.org/name.json': { type: 'string', title: 'Name' } });
    const input: RJSFSchema = {
      type: 'object',
      properties: { name: { $ref: 'https://cdn.example.org/name.json' } },
    };
    await resolveRefs(input);
    expect(input.properties).toEqual({
      name: { $ref: 'https://cdn.example.org/name.json' },
    });
  });

  it('follows a ref chain and reuses the cache for a repeated ref', async () => {
    serve({
      'https://cdn.example.org/outer.json': { $ref: 'https://cdn.example.org/leaf.json' },
      'https://cdn.example.org/leaf.json': { type: 'string', title: 'Leaf' },
    });

    const resolved = await resolveRefs({
      type: 'object',
      properties: {
        a: { $ref: 'https://cdn.example.org/outer.json' },
        b: { $ref: 'https://cdn.example.org/leaf.json' },
      },
    });

    const props = resolved.properties as Record<string, RJSFSchema>;
    expect(props.a).toEqual({ type: 'string', title: 'Leaf' });
    expect(props.b).toEqual({ type: 'string', title: 'Leaf' });
    expect(fetchedUrls()).toEqual([
      'https://cdn.example.org/outer.json',
      'https://cdn.example.org/leaf.json',
    ]);
  });

  it('joins baseUrl without stripping a leading "./" (unlike resolveRefString)', async () => {
    serve({ 'https://cdn.example.org/schemas/./name.json': { type: 'string' } });
    await resolveRefs({ $ref: './name.json' }, 'https://cdn.example.org/schemas');
    expect(fetchedUrls()).toEqual(['https://cdn.example.org/schemas/./name.json']);
  });

  it('fetches a relative ref verbatim when no baseUrl is supplied', async () => {
    serve({ 'name.json': { type: 'string' } });
    await expect(resolveRefs({ $ref: 'name.json' })).resolves.toEqual({ type: 'string' });
    expect(fetchedUrls()).toEqual(['name.json']);
  });

  it('reports the resolved url and status when a ref fetch fails', async () => {
    serve({});
    await expect(
      resolveRefs({ $ref: 'gone.json' }, 'https://cdn.example.org')
    ).rejects.toThrow(/Failed to resolve \$ref https:\/\/cdn.example.org\/gone.json: 404/);
  });

  it('leaves a schema without refs structurally intact', async () => {
    const plain: RJSFSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    await expect(resolveRefs(plain)).resolves.toEqual(plain);
    expect(fetchedUrls()).toEqual([]);
  });
});

describe('mergeAllOf', () => {
  it('unions properties and concatenates required across branches', () => {
    const merged = mergeAllOf([
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    ]);

    expect(merged.type).toBe('object');
    expect(merged.properties).toEqual({
      a: { type: 'string' },
      b: { type: 'number' },
    });
    expect(merged.required).toEqual(['a', 'b']);
  });

  it('lets a later branch override an earlier property of the same name', () => {
    const merged = mergeAllOf([
      { properties: { a: { type: 'string', title: 'First' } } },
      { properties: { a: { type: 'number', title: 'Second' } } },
    ]);
    expect(merged.properties).toEqual({ a: { type: 'number', title: 'Second' } });
  });

  it('keeps the last description it sees', () => {
    const merged = mergeAllOf([
      { description: 'first' },
      { description: 'second' },
      { properties: {} },
    ]);
    expect(merged.description).toBe('second');
  });

  it('omits `required` entirely when no branch requires anything', () => {
    const merged = mergeAllOf([{ properties: { a: { type: 'string' } } }]);
    expect('required' in merged).toBe(false);
  });

  it('returns an empty object schema for an empty branch list', () => {
    expect(mergeAllOf([])).toEqual({ type: 'object', properties: {} });
  });

  it('does not de-duplicate a field required by two branches', () => {
    const merged = mergeAllOf([{ required: ['a'] }, { required: ['a', 'b'] }]);
    expect(merged.required).toEqual(['a', 'a', 'b']);
  });
});

describe('loadSchema', () => {
  it('fetches a string url once and serves the second call from cache', async () => {
    const doc = { type: 'object', title: 'Remote' };
    serve({ 'https://cdn.example.org/profile.json': doc });

    await expect(loadSchema('https://cdn.example.org/profile.json')).resolves.toEqual(doc);
    await expect(loadSchema('https://cdn.example.org/profile.json')).resolves.toEqual(doc);
    expect(fetchedUrls()).toEqual(['https://cdn.example.org/profile.json']);
  });

  it('accepts a { url } input and caches under that url', async () => {
    const doc = { type: 'object', title: 'By url' };
    serve({ 'https://cdn.example.org/by-url.json': doc });

    await expect(
      loadSchema({ url: 'https://cdn.example.org/by-url.json' })
    ).resolves.toEqual(doc);
    expect(getCachedSchema('https://cdn.example.org/by-url.json')).toEqual(doc);
  });

  it('joins { api, baseUrl } into one url and caches under the joined key', async () => {
    const doc = { type: 'object', title: 'From api' };
    serve({ 'https://api.example.org/api/v1/network/yellow_dot': doc });

    await expect(
      loadSchema({
        api: '/api/v1/network/yellow_dot',
        baseUrl: 'https://api.example.org',
      })
    ).resolves.toEqual(doc);
    expect(fetchedUrls()).toEqual(['https://api.example.org/api/v1/network/yellow_dot']);
    expect(
      getCachedSchema('https://api.example.org/api/v1/network/yellow_dot')
    ).toEqual(doc);
  });

  it('treats a missing baseUrl on an { api } input as an empty prefix', async () => {
    const doc = { type: 'object', title: 'Relative api' };
    serve({ '/api/v1/network/yellow_dot': doc });

    await expect(loadSchema({ api: '/api/v1/network/yellow_dot' })).resolves.toEqual(doc);
    expect(fetchedUrls()).toEqual(['/api/v1/network/yellow_dot']);
    expect(getCachedSchema('/api/v1/network/yellow_dot')).toEqual(doc);
  });

  it('returns an inline schema object as-is and never caches or fetches it', async () => {
    const inline: SchemaInput = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    await expect(loadSchema(inline)).resolves.toBe(inline);
    expect(fetchedUrls()).toEqual([]);
    expect(getCachedSchema('type')).toBeUndefined();
  });

  it('returns an inline DotProfileSchema wrapper without unwrapping it', async () => {
    const wrapper: DotProfileSchema = {
      info: 'student profile',
      name: 'profile',
      version: '1.0',
      details: { dot: 'yellow_dot', domain: 'student' },
      schema_type: 'profile',
      schema: { type: 'object' },
    };
    await expect(loadSchema(wrapper)).resolves.toBe(wrapper);
    expect(fetchedUrls()).toEqual([]);
  });

  it('throws on a non-ok response and caches nothing, so a retry re-fetches', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({}, { ok: false, status: 503 }))
    );
    const doc = { type: 'object', title: 'Recovered' };
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(doc)));

    await expect(loadSchema('https://cdn.example.org/flaky.json')).rejects.toThrow(
      /Failed to fetch schema from https:\/\/cdn.example.org\/flaky.json: 503/
    );
    expect(getCachedSchema('https://cdn.example.org/flaky.json')).toBeUndefined();

    await expect(loadSchema('https://cdn.example.org/flaky.json')).resolves.toEqual(doc);
    expect(fetchedUrls()).toHaveLength(2);
  });

  it('serves an entry seeded by setCachedSchema without fetching', async () => {
    const seeded: RJSFSchema = { type: 'object', title: 'Seeded' };
    setCachedSchema('https://cdn.example.org/seeded.json', seeded);
    await expect(loadSchema('https://cdn.example.org/seeded.json')).resolves.toBe(seeded);
    expect(fetchedUrls()).toEqual([]);
  });

  it('re-fetches after clearSchemaCache drops the entry', async () => {
    serve({ 'https://cdn.example.org/profile.json': { type: 'object' } });
    await loadSchema('https://cdn.example.org/profile.json');
    clearSchemaCache();
    await loadSchema('https://cdn.example.org/profile.json');
    expect(fetchedUrls()).toHaveLength(2);
  });

  it('shares one cache with the $ref resolvers, so a loaded url satisfies a $ref', async () => {
    const doc = { type: 'string', title: 'Shared' };
    serve({ 'https://cdn.example.org/shared.json': doc });

    await loadSchema('https://cdn.example.org/shared.json');
    await expect(
      resolveRefs({ $ref: 'https://cdn.example.org/shared.json' })
    ).resolves.toEqual(doc);
    expect(fetchedUrls()).toEqual(['https://cdn.example.org/shared.json']);
  });
});
