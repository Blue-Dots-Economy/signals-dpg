import { describe, it, expect, vi } from 'vitest';
import { createClientCredentialsTokenSource, TokenSourceError } from '../token_source';

const TOKEN_URL = 'http://keycloak:8080/realms/bluedots/protocol/openid-connect/token';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function setup(respond: () => Response | Promise<Response> = () =>
  json({ access_token: 'tok-1', expires_in: 300 })) {
  let clock = 0;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const source = createClientCredentialsTokenSource({
    tokenUrl: TOKEN_URL,
    clientId: 'signals-api',
    clientSecret: 's3cret',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
  });
  return { source, fetchImpl, setClock: (ms: number) => { clock = ms; } };
}

describe('createClientCredentialsTokenSource', () => {
  it('POSTs a form-encoded client_credentials grant to the token URL', async () => {
    const { source, fetchImpl } = setup();

    expect(await source.token()).toBe('tok-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(TOKEN_URL);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('signals-api');
    expect(form.get('client_secret')).toBe('s3cret');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('caches the token until 30 s before expiry', async () => {
    const { source, fetchImpl, setClock } = setup();

    await source.token();
    setClock(269_999); // 300 s lifetime - 30 s margin = 270 s
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    setClock(270_000);
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches for at least 10 s even when expires_in is shorter than the margin', async () => {
    const { source, fetchImpl, setClock } = setup(() =>
      json({ access_token: 'short', expires_in: 5 })
    );

    await source.token();
    setClock(9_999);
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    setClock(10_000);
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    let release!: (r: Response) => void;
    const { source, fetchImpl } = setup(
      () => new Promise<Response>((resolve) => { release = resolve; })
    );

    const all = Promise.all([source.token(), source.token(), source.token()]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release(json({ access_token: 'shared', expires_in: 300 }));

    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a refetch', async () => {
    let n = 0;
    const { source, fetchImpl } = setup(() => {
      n += 1;
      return json({ access_token: `tok-${n}`, expires_in: 300 });
    });

    expect(await source.token()).toBe('tok-1');
    source.invalidate();
    expect(await source.token()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a fetch started before invalidate() does not repopulate the cache', async () => {
    let n = 0;
    let release!: (r: Response) => void;
    const { source, fetchImpl } = setup(() => {
      n += 1;
      if (n === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json({ access_token: `tok-${n}`, expires_in: 300 });
    });

    const first = source.token();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    source.invalidate();
    release(json({ access_token: 'stale', expires_in: 300 }));
    expect(await first).toBe('stale');

    expect(await source.token()).toBe('tok-2');
  });

  it('a non-2xx answer throws naming the status, without the response body', async () => {
    const { source } = setup(
      () => new Response('{"error":"invalid_client","secret":"s3cret"}', { status: 401 })
    );

    const err = await source.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenSourceError);
    expect((err as TokenSourceError).status).toBe(401);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('invalid_client');
    expect((err as Error).message).not.toContain('s3cret');
  });

  it('a 2xx answer with no access_token throws', async () => {
    const { source } = setup(() => json({ token_type: 'Bearer' }));

    await expect(source.token()).rejects.toThrow(TokenSourceError);
  });

  it('a failed fetch is not cached: the next call tries again', async () => {
    let n = 0;
    const { source, fetchImpl } = setup(() => {
      n += 1;
      return n === 1
        ? new Response('down', { status: 503 })
        : json({ access_token: 'recovered', expires_in: 300 });
    });

    await expect(source.token()).rejects.toThrow(/503/);
    expect(await source.token()).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
