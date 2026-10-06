import { describe, it, expect, vi, afterEach } from 'vitest';
import { NotificationClient } from '../notification_client';
import { NotifyTransportError, type NotifyEvent } from '../notify_event';
import { createClientCredentialsTokenSource, type TokenSource } from '../token_source';

const TOKEN = 'super-secret-bearer-token';
const OTP = '493817';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const ACCEPTED = { notification_event_id: 'evt-1', correlation_id: 'corr-1' };

const EVENT: NotifyEvent = {
  event_type: 'guardian.otp.account',
  domain: null,
  to: { email: 'parent@example.org' },
  variables: { message: OTP, parentName: 'Asha' },
};

function fakeTokens(impl: () => Promise<string> = async () => TOKEN) {
  return { token: vi.fn(impl), invalidate: vi.fn() } satisfies TokenSource;
}

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setup(opts: {
  baseUrl?: string;
  respond?: FetchFn;
  tokens?: ReturnType<typeof fakeTokens>;
  timeoutMs?: number;
} = {}) {
  const fetchImpl = vi.fn<FetchFn>(opts.respond ?? (async () => json(ACCEPTED, 202)));
  const tokens = opts.tokens ?? fakeTokens();
  const client = new NotificationClient({
    baseUrl: opts.baseUrl ?? 'http://ns:3000',
    tokens,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { client, fetchImpl, tokens };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NotificationClient.send — the request', () => {
  it.each([
    ['http://ns:3000', 'http://ns:3000/v1/notify'],
    ['http://ns:3000/', 'http://ns:3000/v1/notify'],
    ['http://ns:3000/some/path', 'http://ns:3000/v1/notify'],
    ['http://ns:3000/some/path/', 'http://ns:3000/v1/notify'],
  ])('posts to exactly <origin>/v1/notify for base %s', async (baseUrl, expected) => {
    const { client, fetchImpl } = setup({ baseUrl });
    await client.send(EVENT);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(expected);
  });

  it('sends POST with a bearer token and a JSON content type', async () => {
    const { client, fetchImpl } = setup();
    await client.send(EVENT);

    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    expect(headers).not.toHaveProperty('x-correlation-id');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the correlation header when the event carries one', async () => {
    const { client, fetchImpl } = setup();
    await client.send({ ...EVENT, correlation_id: 'req-42' });

    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['x-correlation-id']).toBe('req-42');
  });

  it('defaults priority to normal and keeps the rest of the event', async () => {
    const { client, fetchImpl } = setup();
    await client.send(EVENT);

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    const { domain: _domain, ...rest } = EVENT;
    expect(body).toEqual({ ...rest, priority: 'normal' });
  });

  it('omits a null domain on the wire: the service reads an absent domain as "no recipient domain"', async () => {
    const { client, fetchImpl } = setup();
    await client.send({ ...EVENT, domain: null });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body).not.toHaveProperty('domain');
  });

  it('keeps a real domain', async () => {
    const { client, fetchImpl } = setup();
    await client.send({ ...EVENT, domain: 'seeker' });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body.domain).toBe('seeker');
  });

  it('keeps an explicit priority', async () => {
    const { client, fetchImpl } = setup();
    await client.send({ ...EVENT, priority: 'urgent' });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body.priority).toBe('urgent');
  });
});

describe('NotificationClient.send — the verdict', () => {
  it('202 gives ok:true with the body', async () => {
    const { client } = setup();
    expect(await client.send(EVENT)).toEqual({ ok: true, status: 202, body: ACCEPTED });
  });

  it('200 (an idempotent repeat) gives ok:true', async () => {
    const { client } = setup({ respond: async () => json(ACCEPTED, 200) });
    expect(await client.send(EVENT)).toEqual({ ok: true, status: 200, body: ACCEPTED });
  });

  it('422 gives ok:false with the service error code and kind', async () => {
    const { client, fetchImpl } = setup({
      respond: async () => json({ error: 'no_policy', kind: 'configuration' }, 422),
    });

    expect(await client.send(EVENT)).toEqual({
      ok: false,
      status: 422,
      error: 'no_policy',
      kind: 'configuration',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never retried
  });

  it('a non-JSON error body gives error http_<status> and no kind', async () => {
    const { client } = setup({
      respond: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });

    expect(await client.send(EVENT)).toEqual({ ok: false, status: 502, error: 'http_502' });
  });

  it('401 refreshes the token once and retries once', async () => {
    let calls = 0;
    const { client, fetchImpl, tokens } = setup({
      respond: async () => {
        calls += 1;
        return calls === 1 ? json({ error: 'unauthorized' }, 401) : json(ACCEPTED, 202);
      },
    });

    expect(await client.send(EVENT)).toEqual({ ok: true, status: 202, body: ACCEPTED });
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(tokens.token).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a second 401 gives ok:false status 401, with no third call', async () => {
    const { client, fetchImpl, tokens } = setup({
      respond: async () => json({ error: 'unauthorized' }, 401),
    });

    expect(await client.send(EVENT)).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationClient.send — transport failures', () => {
  it('token fetch failure surfaces as a send failure, never a hang', async () => {
    const tokens = fakeTokens(async () => {
      throw new Error('token endpoint answered 503');
    });
    const { client, fetchImpl } = setup({ tokens });

    await expect(client.send(EVENT)).rejects.toThrow(NotifyTransportError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a network error rejects with NotifyTransportError', async () => {
    const { client } = setup({
      respond: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.send(EVENT)).rejects.toThrow(NotifyTransportError);
  });

  it('a timeout aborts the request and rejects with NotifyTransportError', async () => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout runs on an internal timer the fake clock does
    // not drive, so back it with a (faked) setTimeout for the same duration.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        ms
      );
      return controller.signal;
    });
    const { client } = setup({
      timeoutMs: 5_000,
      // Never answers on its own; only the abort signal ends it.
      respond: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });

    const pending = client.send(EVENT);
    const assertion = expect(pending).rejects.toThrow(NotifyTransportError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('a token fetch past its timeout rejects with NotifyTransportError, without calling the service', async () => {
    vi.useFakeTimers();
    // Same fake-clock backing for AbortSignal.timeout as the request-timeout test.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        ms
      );
      return controller.signal;
    });
    // The token endpoint never answers on its own; only the abort signal ends it.
    const tokenFetch = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })
    );
    const tokens = createClientCredentialsTokenSource({
      tokenUrl: 'http://keycloak:8080/realms/bluedots/protocol/openid-connect/token',
      clientId: 'signals-api',
      clientSecret: 's3cret',
      fetchImpl: tokenFetch as unknown as typeof fetch,
      timeoutMs: 2_000,
    });
    const fetchImpl = vi.fn<FetchFn>(async () => json(ACCEPTED, 202));
    const client = new NotificationClient({
      baseUrl: 'http://ns:3000',
      tokens,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pending = client.send(EVENT);
    const assertion = expect(pending).rejects.toThrow(NotifyTransportError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(2_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults the timeout to 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client } = setup();
    await client.send(EVENT);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});

describe('NotificationClient.send — no secrets in errors or logs', () => {
  const spyConsole = () =>
    (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );

  const leaks = (text: string) =>
    [TOKEN, OTP, 'Asha', 'parent@example.org'].filter((s) => text.includes(s));

  it.each([
    [
      'token failure',
      () =>
        setup({
          tokens: fakeTokens(async () => {
            throw new Error(`refused for ${TOKEN}`);
          }),
        }),
    ],
    [
      'network failure',
      () =>
        setup({
          respond: async () => {
            throw new TypeError(`connect failed while sending ${OTP} with ${TOKEN}`);
          },
        }),
    ],
  ])('%s: the error message names neither the token nor any variable', async (_name, make) => {
    const spies = spyConsole();
    const { client } = make();

    const err = (await client.send(EVENT).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NotifyTransportError);
    expect(leaks(err.message)).toEqual([]);
    expect(leaks(String(err.stack))).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('a refusal result carries only the error code, not the request', async () => {
    const spies = spyConsole();
    const { client } = setup({
      respond: async () => json({ error: 'unknown_variable', kind: 'caller' }, 422),
    });

    const result = await client.send(EVENT);
    expect(leaks(JSON.stringify(result))).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
