import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Coverage for the three thin plumbing modules:
 *   - api-config.ts    (API base-URL resolution: runtime /config.js > build-time)
 *   - digilocker-api.ts (agent-backed DigiLocker fetch wrapper)
 *   - auth-api.ts       (unified-OTP wrappers; identifier normalization)
 *
 * All three read module-scope config at import time, so every case re-imports
 * the module through vi.resetModules() with the environment set up first.
 */

type UiRuntimeConfig = NonNullable<Window['__DPG_UI_CONFIG__']>;

function setRuntimeConfig(config: UiRuntimeConfig | undefined) {
  if (config) {
    window.__DPG_UI_CONFIG__ = config;
  } else {
    delete window.__DPG_UI_CONFIG__;
  }
}

afterEach(() => {
  setRuntimeConfig(undefined);
  localStorage.removeItem('selectedApiUrl');
  vi.doUnmock('../api-client');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// api-config.ts
// ---------------------------------------------------------------------------

interface CompileTimeApiEnv {
  apiUrl?: string;
  defaultApiUrl?: string;
  apiUrls?: string;
  showSelector?: string;
  dev?: boolean;
}

async function loadApiConfig(
  runtime: UiRuntimeConfig | undefined,
  compileTime: CompileTimeApiEnv = {},
) {
  vi.resetModules();
  setRuntimeConfig(runtime);
  vi.stubEnv('VITE_API_URL', compileTime.apiUrl);
  vi.stubEnv('VITE_DEFAULT_API_URL', compileTime.defaultApiUrl);
  vi.stubEnv('VITE_API_URLS', compileTime.apiUrls);
  vi.stubEnv('VITE_SHOW_INSTANCE_SELECTOR', compileTime.showSelector);
  vi.stubEnv('DEV', compileTime.dev ?? false);
  const { apiConfig } = await import('../api-config');
  return apiConfig;
}

describe('api-config: base URL resolution', () => {
  it('prefers the runtime /config.js URL over the build-time one', async () => {
    const apiConfig = await loadApiConfig(
      { VITE_DEFAULT_API_URL: 'https://runtime.example' },
      { defaultApiUrl: 'https://baked-in.example', dev: true },
    );

    expect(apiConfig.getUrl()).toBe('https://runtime.example');
    expect(apiConfig.getEndpoints()[0]).toEqual({
      key: 'default',
      label: 'Default (https://runtime.example)',
      url: 'https://runtime.example',
    });
  });

  it('treats an empty runtime URL as same-origin, ignoring the baked-in value', async () => {
    // A deployment whose config.js ships VITE_API_URL:'' wants nginx to proxy
    // /api/* on the current host — the build-time localhost value must not win.
    const apiConfig = await loadApiConfig(
      { VITE_API_URL: '' },
      { defaultApiUrl: 'https://baked-in.example', dev: true },
    );

    expect(apiConfig.getUrl()).toBe('');
  });

  it('falls back to the runtime VITE_API_URL when VITE_DEFAULT_API_URL is absent', async () => {
    const apiConfig = await loadApiConfig({ VITE_API_URL: 'https://runtime-alt.example' });

    expect(apiConfig.getUrl()).toBe('https://runtime-alt.example');
  });

  it('uses the build-time URL when no runtime config is injected', async () => {
    const apiConfig = await loadApiConfig(undefined, {
      apiUrl: 'https://compile-time.example',
      dev: true,
    });

    expect(apiConfig.getUrl()).toBe('https://compile-time.example');
  });

  it('falls back to localhost:2742 in dev when nothing is configured', async () => {
    const apiConfig = await loadApiConfig(undefined, { dev: true });

    expect(apiConfig.getUrl()).toBe('http://localhost:2742');
  });

  it('falls back to same-origin in prod when nothing is configured', async () => {
    const apiConfig = await loadApiConfig(undefined, { dev: false });

    expect(apiConfig.getUrl()).toBe('');
    expect(apiConfig.getEndpoints()).toHaveLength(1);
  });
});

describe('api-config: additional endpoints + selection', () => {
  it('adds one endpoint per entry of the VITE_API_URLS map', async () => {
    const apiConfig = await loadApiConfig({
      VITE_DEFAULT_API_URL: 'https://a.example',
      VITE_API_URLS: JSON.stringify({ staging: 'https://s.example', prod: 'https://p.example' }),
    });

    expect(apiConfig.getEndpoints().map((e) => e.key)).toEqual(['default', 'staging', 'prod']);
    expect(apiConfig.getEndpoints()[1]).toEqual({
      key: 'staging',
      label: 'staging (https://s.example)',
      url: 'https://s.example',
    });
  });

  it('ignores an unparseable VITE_API_URLS instead of throwing', async () => {
    const apiConfig = await loadApiConfig(undefined, {
      apiUrl: 'https://only.example',
      apiUrls: '{not json',
      dev: true,
    });

    expect(apiConfig.getEndpoints()).toHaveLength(1);
    expect(apiConfig.getUrl()).toBe('https://only.example');
  });

  it('restores a stored selection that still matches a known endpoint', async () => {
    localStorage.setItem('selectedApiUrl', 'staging');
    const apiConfig = await loadApiConfig({
      VITE_DEFAULT_API_URL: 'https://a.example',
      VITE_API_URLS: JSON.stringify({ staging: 'https://s.example' }),
    });

    expect(apiConfig.getSelectedKey()).toBe('staging');
    expect(apiConfig.getUrl()).toBe('https://s.example');
  });

  it('drops a stale stored selection and falls back to the default endpoint', async () => {
    localStorage.setItem('selectedApiUrl', 'retired-instance');
    const apiConfig = await loadApiConfig({
      VITE_DEFAULT_API_URL: 'https://a.example',
      VITE_API_URLS: JSON.stringify({ staging: 'https://s.example' }),
    });

    expect(apiConfig.getSelectedKey()).toBeNull();
    expect(apiConfig.getUrl()).toBe('https://a.example');
  });

  it('persists a new selection to localStorage and switches the resolved URL', async () => {
    const apiConfig = await loadApiConfig({
      VITE_DEFAULT_API_URL: 'https://a.example',
      VITE_API_URLS: JSON.stringify({ staging: 'https://s.example' }),
    });

    apiConfig.setSelectedKey('staging');

    expect(localStorage.getItem('selectedApiUrl')).toBe('staging');
    expect(apiConfig.getUrl()).toBe('https://s.example');
  });
});

describe('api-config: isDevMode (instance-selector visibility)', () => {
  it('is on when the runtime config opts in, even in a prod build', async () => {
    const apiConfig = await loadApiConfig({ VITE_SHOW_INSTANCE_SELECTOR: 'true' }, { dev: false });

    expect(apiConfig.isDevMode()).toBe(true);
  });

  it('is on when the build-time flag opts in', async () => {
    const apiConfig = await loadApiConfig(undefined, { showSelector: 'true', dev: false });

    expect(apiConfig.isDevMode()).toBe(true);
  });

  it('is off in a prod build with the flag unset or explicitly false', async () => {
    const apiConfig = await loadApiConfig({ VITE_SHOW_INSTANCE_SELECTOR: 'false' }, { dev: false });

    expect(apiConfig.isDevMode()).toBe(false);
  });

  it('defaults to the build mode when neither flag is set', async () => {
    const apiConfig = await loadApiConfig(undefined, { dev: true });

    expect(apiConfig.isDevMode()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// digilocker-api.ts
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; jsonThrows?: boolean } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () =>
      init.jsonThrows ? Promise.reject(new Error('not json')) : Promise.resolve(body),
  } as unknown as Response;
}

async function loadDigiLocker(env: { url?: string; token?: string }) {
  vi.resetModules();
  vi.stubEnv('VITE_AGENT_URL', env.url);
  vi.stubEnv('VITE_AGENT_TOKEN', env.token);
  return import('../digilocker-api');
}

describe('digilocker-api: configuration gate', () => {
  it('exposes a client only when both the agent URL and token are set', async () => {
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });

    expect(mod.isDigiLockerConfigured()).toBe(true);
    expect(mod.digiLockerApi).not.toBeNull();
  });

  it('stays unconfigured when the token is missing', async () => {
    const mod = await loadDigiLocker({ url: 'https://agent.example' });

    expect(mod.isDigiLockerConfigured()).toBe(false);
    expect(mod.digiLockerApi).toBeNull();
  });

  it('treats whitespace-only env values as unconfigured', async () => {
    const mod = await loadDigiLocker({ url: '   ', token: '  ' });

    expect(mod.isDigiLockerConfigured()).toBe(false);
    expect(mod.digiLockerApi).toBeNull();
  });
});

describe('digilocker-api: callback origin allowlist', () => {
  it('always trusts the app origin and adds the configured agent origin', async () => {
    const mod = await loadDigiLocker({ url: 'https://agent.example/base', token: 'tok' });

    expect(mod.getDigiLockerCallbackOrigins()).toEqual([
      window.location.origin,
      'https://agent.example',
    ]);
  });

  it('falls back to the app origin alone when the agent URL is relative or unset', async () => {
    const relative = await loadDigiLocker({ url: '/agent', token: 'tok' });
    expect(relative.getDigiLockerCallbackOrigins()).toEqual([window.location.origin]);

    const unset = await loadDigiLocker({});
    expect(unset.getDigiLockerCallbackOrigins()).toEqual([window.location.origin]);
  });

  it('never allowlists the opaque "null" origin', async () => {
    // `new URL('mailto:…').origin` is the string "null", which is also what a
    // sandboxed frame reports — allowlisting it would re-open the hole.
    const mod = await loadDigiLocker({ url: 'mailto:agent@example.org', token: 'tok' });

    const origins = mod.getDigiLockerCallbackOrigins();
    expect(origins).not.toContain('null');
    expect(origins).toEqual([window.location.origin]);
  });
});

describe('digilocker-api: requests', () => {
  it('GETs the digilocker-request endpoint with the bearer token and trimmed base URL', async () => {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ url: 'https://digilocker.example/authorize' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadDigiLocker({ url: '  https://agent.example  ', token: '  tok  ' });

    await expect(mod.digiLockerApi?.initiateRequest()).resolves.toEqual({
      url: 'https://digilocker.example/authorize',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://agent.example/api/v1/discover/digilocker-request',
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
  });

  it('POSTs the auth code with the default aadhaar doctype', async () => {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: { credentialSubject: { name: 'Asha' } } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });

    const result = await mod.digiLockerApi?.completeAuth('code-123');

    expect(result?.data.credentialSubject).toEqual({ name: 'Asha' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://agent.example/api/v1/discover/digilocker-auth',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ code: 'code-123', doctype: 'aadhaar' }),
    );
  });

  it('forwards an explicit doctype', async () => {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: { credentialSubject: {} } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });

    await mod.digiLockerApi?.completeAuth('code-9', 'driving_licence');

    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ code: 'code-9', doctype: 'driving_licence' }),
    );
  });

  it("surfaces the agent's error message on a failed response", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, _init?: RequestInit) =>
        Promise.resolve(
          jsonResponse({ message: 'consent expired' }, { ok: false, status: 403 }),
        ),
      ),
    );
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });

    await expect(mod.digiLockerApi?.completeAuth('bad-code')).rejects.toThrow('consent expired');
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse(null, { ok: false, status: 502, jsonThrows: true })),
      ),
    );
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });

    await expect(mod.digiLockerApi?.initiateRequest()).rejects.toThrow('HTTP error 502');
  });
});

describe('digilocker-api: transformCredentialSubject', () => {
  it('returns import candidates for nested credential fields and keeps the raw payload', async () => {
    const mod = await loadDigiLocker({ url: 'https://agent.example', token: 'tok' });
    const subject = {
      fullName: 'Asha Rao',
      address: { city: 'Pune' },
    };

    const result = mod.digiLockerApi?.transformCredentialSubject(subject);

    // Nothing is auto-applied to the form: mapping happens later against the
    // item schema, so `data` starts empty and candidates carry the aliases.
    expect(result?.data).toEqual({});
    expect(result?.rawPayload).toBe(subject);
    expect(result?.candidates.fullName).toBe('Asha Rao');
    expect(result?.candidates.full_name).toBe('Asha Rao');
    expect(result?.candidates['address.city']).toBe('Pune');
    expect(result?.candidates.city).toBe('Pune');
  });
});

// ---------------------------------------------------------------------------
// auth-api.ts
// ---------------------------------------------------------------------------

type MockResponse = { data: unknown };

async function loadAuthApi(handlers: {
  post?: (url: string, body?: unknown) => Promise<MockResponse>;
  get?: (url: string) => Promise<MockResponse>;
}) {
  vi.resetModules();
  const post = vi.fn(
    handlers.post ?? ((_url: string, _body?: unknown) => Promise.resolve({ data: {} })),
  );
  const get = vi.fn(handlers.get ?? ((_url: string) => Promise.resolve({ data: {} })));
  vi.doMock('../api-client', () => ({ createApiClient: () => ({ post, get }) }));
  const mod = await import('../auth-api');
  return { mod, post, get };
}

describe('auth-api: identifier normalization on the wire', () => {
  it('checkUser lowercases/trims the email and canonicalizes the phone', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { userExists: true } }),
    });

    await expect(
      mod.checkUser({ email: '  Asha@Example.COM ', phoneNumber: '(987) 654-3210' }),
    ).resolves.toEqual({ userExists: true });

    expect(post.mock.calls[0][0]).toBe('/api/auth/unified-otp/check-user');
    expect(post.mock.calls[0][1]).toEqual({
      email: 'asha@example.com',
      phoneNumber: '+919876543210',
    });
  });

  it('omits blank identifier fields rather than sending empty strings', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { userExists: false } }),
    });

    await mod.checkUser({ email: '', phoneNumber: '9876543210' });

    expect(post.mock.calls[0][1]).toEqual({ phoneNumber: '+919876543210' });
  });

  it('requestOtp posts the normalized identifier and returns the ok/user flags', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { ok: true, user: false } }),
    });

    await expect(mod.requestOtp({ phoneNumber: '+91 98765 43210' })).resolves.toEqual({
      ok: true,
      user: false,
    });

    expect(post.mock.calls[0][0]).toBe('/api/auth/unified-otp/request');
    expect(post.mock.calls[0][1]).toEqual({ phoneNumber: '+919876543210' });
  });

  it('u18Precheck sends the network alongside the identifier', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { requiresDob: true } }),
    });

    await expect(
      mod.u18Precheck('yellow_dot', { phoneNumber: '9876543210' }),
    ).resolves.toEqual({ requiresDob: true });

    expect(post.mock.calls[0][0]).toBe('/api/v1/auth/u18-precheck');
    expect(post.mock.calls[0][1]).toEqual({
      network: 'yellow_dot',
      phoneNumber: '+919876543210',
    });
  });
});

describe('auth-api: verify / session endpoints', () => {
  const user = {
    id: 'u1',
    name: 'Asha',
    email: 'asha@example.com',
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
    image: '',
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('verifyOtp defaults the name to "user" when none is supplied', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { redirect: false, token: 't1', user } }),
    });

    await expect(mod.verifyOtp({ email: 'Asha@Example.com' }, '123456')).resolves.toEqual({
      redirect: false,
      token: 't1',
      user,
    });

    expect(post.mock.calls[0][0]).toBe('/api/auth/unified-otp/verify');
    expect(post.mock.calls[0][1]).toEqual({
      email: 'asha@example.com',
      otp: '123456',
      name: 'user',
    });
  });

  it('verifyOtp forwards a supplied name and falls back for an empty one', async () => {
    const { mod, post } = await loadAuthApi({
      post: () => Promise.resolve({ data: { redirect: true, token: 't2', user } }),
    });

    await mod.verifyOtp({ phoneNumber: '9876543210' }, '000111', 'Asha Rao');
    await mod.verifyOtp({ phoneNumber: '9876543210' }, '000111', '');

    expect(post.mock.calls[0][1]).toEqual({
      phoneNumber: '+919876543210',
      otp: '000111',
      name: 'Asha Rao',
    });
    expect(post.mock.calls[1][1]).toEqual({
      phoneNumber: '+919876543210',
      otp: '000111',
      name: 'user',
    });
  });

  it('signOut posts the sign-out endpoint with no body', async () => {
    const { mod, post } = await loadAuthApi({});

    await expect(mod.signOut()).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/auth/sign-out');
    expect(post.mock.calls[0]).toHaveLength(1);
  });

  it('getSession returns the session payload from /api/auth/get-session', async () => {
    const session = { id: 's1', expiresAt: '2026-02-01T00:00:00.000Z' };
    const { mod, get } = await loadAuthApi({
      get: () => Promise.resolve({ data: { user, token: 't3', session } }),
    });

    await expect(mod.getSession()).resolves.toEqual({ user, token: 't3', session });
    expect(get.mock.calls[0][0]).toBe('/api/auth/get-session');
  });

  it('getSession surfaces a signed-out (null) session', async () => {
    const { mod } = await loadAuthApi({
      get: () => Promise.resolve({ data: { user: null, token: null, session: null } }),
    });

    await expect(mod.getSession()).resolves.toEqual({
      user: null,
      token: null,
      session: null,
    });
  });

  it('propagates a rejected request to the caller', async () => {
    const { mod } = await loadAuthApi({
      post: () => Promise.reject(new Error('Network Error')),
    });

    await expect(mod.requestOtp({ phoneNumber: '9876543210' })).rejects.toThrow('Network Error');
  });
});
