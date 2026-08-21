import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchSchema, SchemaFetchError, fetchSchema } from '../schema_registry';

const ROOT = 'https://schemas.test/registry/root.json';

type FakeFetch = {
  fetchFn: typeof fetch;
  calls: string[];
};

/**
 * A `fetch` stand-in serving a fixed URL → JSON document map. Unknown URLs
 * answer 404 so the SchemaFetchError branches are reachable without network.
 */
function makeFetch(documents: Record<string, unknown>): FakeFetch {
  const calls: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchFn = async (input: any): Promise<Response> => {
    const url = String(input);
    calls.push(url);

    if (!Object.hasOwn(documents, url)) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => documents[url],
    } as unknown as Response;
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSchema — plain documents', () => {
  it('resolves a ref-free document and exposes it on .schema after ready', async () => {
    const document = { title: 'profile', type: 'object', properties: { a: { type: 'string' } } };
    const { fetchFn, calls } = makeFetch({ [ROOT]: document });

    const registry = new fetchSchema(ROOT, { fetchFn });
    expect(registry.schema).toBeNull();
    expect(registry.url).toBe(ROOT);

    const resolved = await registry.ready;
    expect(resolved).toEqual(document);
    expect(registry.schema).toEqual(document);
    expect(calls).toEqual([ROOT]);
  });

  it('does no I/O until .ready or getSchema() is touched, so a failure can never go unhandled', async () => {
    // Every URL 404s, so the load would reject if it were started eagerly.
    const { fetchFn, calls } = makeFetch({});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const registry = new fetchSchema(ROOT, { fetchFn });
      expect(registry.schema).toBeNull();

      // Give the microtask + macrotask queues a chance to surface a rejection
      // that nobody is awaiting. Constructing alone must not schedule one.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toEqual([]);
      expect(unhandled).toEqual([]);

      // The failure surfaces to whoever awaits it, as a rejected awaitable.
      await expect(registry.getSchema()).rejects.toBeInstanceOf(SchemaFetchError);
      expect(calls).toEqual([ROOT]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('memoises the load: repeated .ready / getSchema() share one in-flight promise', async () => {
    const document = { title: 'profile' };
    const { fetchFn, calls } = makeFetch({ [ROOT]: document });

    const registry = new fetchSchema(ROOT, { fetchFn });
    expect(registry.ready).toBe(registry.ready);

    const [a, b, c] = await Promise.all([
      registry.ready,
      registry.getSchema(),
      registry.getSchema(),
    ]);
    expect(a).toEqual(document);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(calls).toEqual([ROOT]);
  });

  it('getSchema() returns the `schema` field it is named for', async () => {
    const document = { title: 'profile' };
    const { fetchFn } = makeFetch({ [ROOT]: document });

    const registry = new fetchSchema(ROOT, { fetchFn });
    const viaGetter = await registry.getSchema();

    // Same object identity as the backing field, not a parallel value.
    expect(viaGetter).toBe(registry.schema);
    expect(viaGetter).toEqual(document);
  });

  it('getSchema() returns the same resolved value as .ready', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { type: 'object' } });
    const registry = new fetchSchema(ROOT, { fetchFn });

    const [viaReady, viaGetter] = await Promise.all([registry.ready, registry.getSchema()]);
    expect(viaGetter).toBe(viaReady);
  });

  it('accepts a URL instance and normalizes it to a string', async () => {
    const { fetchFn, calls } = makeFetch({ [ROOT]: { ok: true } });
    const registry = new fetchSchema(new URL(ROOT), { fetchFn });

    await registry.ready;
    expect(registry.url).toBe(ROOT);
    expect(calls).toEqual([ROOT]);
  });

  it('leaves $ref untouched when resolveRefs is false', async () => {
    const document = { properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'string' } } };
    const { fetchFn, calls } = makeFetch({ [ROOT]: document });

    const registry = new fetchSchema(ROOT, { fetchFn, resolveRefs: false });
    const resolved = (await registry.ready) as typeof document;

    expect(resolved.properties.a).toEqual({ $ref: '#/$defs/A' });
    expect(calls).toEqual([ROOT]);
  });

  it('FetchSchema is an alias of fetchSchema', () => {
    expect(FetchSchema).toBe(fetchSchema);
  });

  it('falls back to globalThis.fetch when no fetchFn is supplied', async () => {
    const globalFetch = vi.fn(async (_input: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ from: 'global' }),
    } as unknown as Response));
    vi.stubGlobal('fetch', globalFetch);

    const registry = new fetchSchema(ROOT);
    expect(await registry.ready).toEqual({ from: 'global' });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String(globalFetch.mock.calls[0][0])).toBe(ROOT);
  });
});

describe('fetchSchema — local ($-fragment) references', () => {
  it('inlines a local JSON-pointer reference', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: {
        properties: { name: { $ref: '#/$defs/Name' } },
        $defs: { Name: { type: 'string', maxLength: 10 } },
      },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      properties: { name: unknown };
    };
    expect(resolved.properties.name).toEqual({ type: 'string', maxLength: 10 });
  });

  it('resolves refs nested inside arrays', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: {
        anyOf: [{ $ref: '#/$defs/A' }, { type: 'null' }],
        $defs: { A: { const: 1 } },
      },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as { anyOf: unknown[] };
    expect(resolved.anyOf).toEqual([{ const: 1 }, { type: 'null' }]);
  });

  it('resolves refs transitively (a ref pointing at another ref)', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: {
        properties: { a: { $ref: '#/$defs/A' } },
        $defs: { A: { $ref: '#/$defs/B' }, B: { type: 'integer' } },
      },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      properties: { a: unknown };
    };
    expect(resolved.properties.a).toEqual({ type: 'integer' });
  });

  it('reads array elements through a numeric pointer segment', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: { pick: { $ref: '#/list/1' }, list: ['zero', 'one'] },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as { pick: unknown };
    expect(resolved.pick).toBe('one');
  });

  it('unescapes ~1 as "/" and ~0 as "~" in pointer segments', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: {
        slash: { $ref: '#/$defs/a~1b' },
        tilde: { $ref: '#/$defs/c~0d' },
        $defs: { 'a/b': { const: 'slash' }, 'c~d': { const: 'tilde' } },
      },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      slash: unknown;
      tilde: unknown;
    };
    expect(resolved.slash).toEqual({ const: 'slash' });
    expect(resolved.tilde).toEqual({ const: 'tilde' });
  });

  it('merges sibling keys over the resolved reference, siblings winning', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: {
        properties: {
          a: { $ref: '#/$defs/A', description: 'local override', type: 'number' },
        },
        $defs: { A: { type: 'string', title: 'A' } },
      },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      properties: { a: Record<string, unknown> };
    };
    expect(resolved.properties.a).toEqual({
      title: 'A',
      type: 'number',
      description: 'local override',
    });
    expect(resolved.properties.a).not.toHaveProperty('$ref');
  });

  it('wraps a scalar target under `value` when the $ref node has siblings', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: { node: { $ref: '#/$defs/scalar', note: 'hi' }, $defs: { scalar: 42 } },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as { node: unknown };
    expect(resolved.node).toEqual({ value: 42, note: 'hi' });
  });

  it('returns a scalar target as-is when the $ref node has no siblings', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: { node: { $ref: '#/$defs/scalar' }, $defs: { scalar: 42 } },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as { node: unknown };
    expect(resolved.node).toBe(42);
  });

  it('rejects a pointer to a missing object key', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { a: { $ref: '#/$defs/Missing' }, $defs: {} } });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toThrow(
      'Invalid schema reference fragment: #/$defs/Missing',
    );
  });

  it('rejects an out-of-range array pointer segment', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { a: { $ref: '#/list/5' }, list: ['only'] } });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toThrow(
      'Invalid schema reference fragment: #/list/5',
    );
  });

  it('rejects a non-numeric array pointer segment', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { a: { $ref: '#/list/first' }, list: ['only'] } });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toThrow(
      'Invalid schema reference fragment: #/list/first',
    );
  });

  it('rejects a pointer that walks through a scalar', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { a: { $ref: '#/leaf/deeper' }, leaf: 'string' } });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toThrow(
      'Invalid schema reference fragment: #/leaf/deeper',
    );
  });
});

describe('fetchSchema — remote references', () => {
  const SHARED = 'https://schemas.test/registry/shared.json';

  it('resolves a relative remote ref against the document URL, with a fragment', async () => {
    const { fetchFn, calls } = makeFetch({
      [ROOT]: { properties: { a: { $ref: 'shared.json#/$defs/Email' } } },
      [SHARED]: { $defs: { Email: { type: 'string', format: 'email' } } },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      properties: { a: unknown };
    };
    expect(resolved.properties.a).toEqual({ type: 'string', format: 'email' });
    expect(calls).toEqual([ROOT, SHARED]);
  });

  it('inlines the whole remote document when the ref carries no fragment', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: { properties: { a: { $ref: 'shared.json' } } },
      [SHARED]: { type: 'object', title: 'shared' },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      properties: { a: unknown };
    };
    expect(resolved.properties.a).toEqual({ type: 'object', title: 'shared' });
  });

  it('re-bases nested refs onto the referenced document, not the root', async () => {
    const nested = 'https://schemas.test/registry/nested/inner.json';
    const sibling = 'https://schemas.test/registry/nested/sibling.json';
    const { fetchFn, calls } = makeFetch({
      [ROOT]: { a: { $ref: 'nested/inner.json' } },
      // `sibling.json` here must resolve against nested/, not against registry/.
      [nested]: { b: { $ref: 'sibling.json#/const' }, c: { $ref: '#/local' }, local: 'inner-local' },
      [sibling]: { const: 'from-sibling' },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      a: { b: unknown; c: unknown };
    };
    expect(resolved.a.b).toBe('from-sibling');
    // A local `#/...` ref inside a referenced document resolves against THAT
    // document's root, not the root schema.
    expect(resolved.a.c).toBe('inner-local');
    expect(calls).toEqual([ROOT, nested, sibling]);
  });

  it('caches each remote document so a repeated ref fetches once', async () => {
    const { fetchFn, calls } = makeFetch({
      [ROOT]: {
        a: { $ref: 'shared.json#/$defs/X' },
        b: { $ref: 'shared.json#/$defs/X' },
        c: { $ref: 'shared.json' },
      },
      [SHARED]: { $defs: { X: { const: 'x' } } },
    });

    const resolved = (await new fetchSchema(ROOT, { fetchFn }).ready) as {
      a: unknown;
      b: unknown;
    };
    expect(resolved.a).toEqual({ const: 'x' });
    expect(resolved.b).toEqual({ const: 'x' });
    expect(calls.filter((url) => url === SHARED)).toHaveLength(1);
  });

  it('strips the fragment from the fetched URL', async () => {
    const { fetchFn, calls } = makeFetch({
      [ROOT]: { a: { $ref: 'shared.json#/$defs/X' } },
      [SHARED]: { $defs: { X: { const: 'x' } } },
    });

    await new fetchSchema(ROOT, { fetchFn }).ready;
    expect(calls).not.toContain(`${SHARED}#/$defs/X`);
  });

  it('propagates an invalid fragment inside a remote document', async () => {
    const { fetchFn } = makeFetch({
      [ROOT]: { a: { $ref: 'shared.json#/$defs/Nope' } },
      [SHARED]: { $defs: {} },
    });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toThrow(
      'Invalid schema reference fragment: #/$defs/Nope',
    );
  });
});

describe('SchemaFetchError', () => {
  it('carries status/statusText for a non-ok response', async () => {
    const { fetchFn } = makeFetch({});

    const error = await new fetchSchema(ROOT, { fetchFn }).ready.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaFetchError);
    const schemaError = error as SchemaFetchError;
    expect(schemaError.name).toBe('SchemaFetchError');
    expect(schemaError.url).toBe(ROOT);
    expect(schemaError.status).toBe(404);
    expect(schemaError.statusText).toBe('Not Found');
    expect(schemaError.message).toBe(`Failed to fetch schema from ${ROOT}: 404 Not Found`);
  });

  it('omits the status segment and keeps the cause when fetch itself throws', async () => {
    const transportError = new Error('ECONNREFUSED');
    const fetchFn = (async () => {
      throw transportError;
    }) as unknown as typeof fetch;

    const error = await new fetchSchema(ROOT, { fetchFn }).ready.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaFetchError);
    const schemaError = error as SchemaFetchError;
    expect(schemaError.message).toBe(`Failed to fetch schema from ${ROOT}`);
    expect(schemaError.status).toBeUndefined();
    expect(schemaError.statusText).toBeUndefined();
    expect(schemaError.cause).toBe(transportError);
  });

  it('drops a blank statusText from the message', () => {
    const error = new SchemaFetchError({ url: ROOT, status: 500, statusText: '' });
    expect(error.message).toBe(`Failed to fetch schema from ${ROOT}: 500`);
  });

  it('surfaces a failing remote ref as a SchemaFetchError for that URL', async () => {
    const { fetchFn } = makeFetch({ [ROOT]: { a: { $ref: 'missing.json' } } });

    const error = await new fetchSchema(ROOT, { fetchFn }).ready.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaFetchError);
    expect((error as SchemaFetchError).url).toBe('https://schemas.test/registry/missing.json');
  });

  it('caches the failure too — a repeated failing ref is fetched only once', async () => {
    const { fetchFn, calls } = makeFetch({
      [ROOT]: { a: { $ref: 'missing.json' }, b: { $ref: 'missing.json' } },
    });

    await expect(new fetchSchema(ROOT, { fetchFn }).ready).rejects.toBeInstanceOf(SchemaFetchError);
    expect(
      calls.filter((url) => url === 'https://schemas.test/registry/missing.json'),
    ).toHaveLength(1);
  });

  it('does NOT wrap a JSON parse failure — the raw error propagates', async () => {
    const parseError = new SyntaxError('Unexpected token <');
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw parseError;
      },
    })) as unknown as typeof fetch;

    const error = await new fetchSchema(ROOT, { fetchFn }).ready.catch((err: unknown) => err);
    expect(error).toBe(parseError);
    expect(error).not.toBeInstanceOf(SchemaFetchError);
  });

  it('rejects with a plain TypeError for a non-absolute schema URL', async () => {
    const { fetchFn, calls } = makeFetch({});

    const error = await new fetchSchema('relative/path.json', { fetchFn }).ready.catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(SchemaFetchError);
    expect(calls).toEqual([]);
  });
});
