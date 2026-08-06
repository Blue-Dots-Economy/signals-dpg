import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import type { ConsentAcceptBody, ProfileConsentAcceptBody } from '@dpg/schemas';

import { extractImportCandidates, mergeImportedDataIntoSchema } from '../import-mapping';
import {
  BrowserLocationError,
  getBrowserLocation,
  isBrowserLocationSupported,
} from '../geo/browser-location';

// ───────────────────────── import-mapping ─────────────────────────

describe('extractImportCandidates', () => {
  it('emits a candidate for the dotted path plus key/snake/camel/normalized variants', () => {
    const candidates = extractImportCandidates({
      credentialSubject: { 'candidate Name': 'Asha Rao' },
    });

    expect(candidates['credentialSubject.candidate Name']).toBe('Asha Rao');
    expect(candidates['candidate Name']).toBe('Asha Rao');
    expect(candidates.candidate_name).toBe('Asha Rao');
    expect(candidates.candidateName).toBe('Asha Rao');
    expect(candidates.candidatename).toBe('Asha Rao');
  });

  it('indexes array entries by position in the path', () => {
    const candidates = extractImportCandidates({
      degrees: [{ title: 'BSc' }, { title: 'MSc' }],
    });

    expect(candidates['degrees.0.title']).toBe('BSc');
    expect(candidates['degrees.1.title']).toBe('MSc');
    // Bare key is first-wins, so the earlier array entry keeps the plain key.
    expect(candidates.title).toBe('BSc');
  });

  it('skips null, undefined and empty-string values', () => {
    const candidates = extractImportCandidates({
      a: null,
      b: undefined,
      c: '',
      d: 0,
      e: false,
    });

    expect(candidates).not.toHaveProperty('a');
    expect(candidates).not.toHaveProperty('b');
    expect(candidates).not.toHaveProperty('c');
    expect(candidates.d).toBe(0);
    expect(candidates.e).toBe(false);
  });

  it('returns no candidates for a bare scalar payload', () => {
    expect(extractImportCandidates('hello')).toEqual({});
    expect(extractImportCandidates(undefined)).toEqual({});
  });
});

describe('mergeImportedDataIntoSchema', () => {
  const stringSchema: RJSFSchema = {
    type: 'object',
    properties: {
      full_name: { type: 'string' },
      hobby: { type: 'string' },
    },
  };

  it('maps a snake_case schema property from a camelCase payload key', () => {
    const result = mergeImportedDataIntoSchema(stringSchema, null, {
      data: { fullName: 'Asha Rao' },
    });

    expect(result.mergedData).toEqual({ full_name: 'Asha Rao' });
    expect(result.mappedCount).toBe(1);
    expect(result.skippedKeys).toEqual([]);
  });

  it('keeps unmapped payload keys in skippedKeys and preserves existing form data', () => {
    const result = mergeImportedDataIntoSchema(
      stringSchema,
      { email: 'asha@example.com', hobby: 'chess' },
      { data: { full_name: 'Asha Rao', unknown_field: 'ignored' } }
    );

    expect(result.mergedData).toEqual({
      email: 'asha@example.com',
      hobby: 'chess',
      full_name: 'Asha Rao',
    });
    expect(result.mappedCount).toBe(1);
    expect(result.skippedKeys).toEqual(['unknown_field']);
  });

  it('coerces a string into a numeric field and a number into a string field', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        age: { type: 'integer' },
        score: { type: 'number' },
        pincode: { type: 'string' },
      },
    };

    const result = mergeImportedDataIntoSchema(schema, null, {
      data: { age: '17', score: '9.5', pincode: 560038 },
    });

    expect(result.mergedData).toEqual({ age: 17, score: 9.5, pincode: '560038' });
    expect(result.mappedCount).toBe(3);
  });

  it('leaves a non-numeric string alone rather than producing NaN', () => {
    const schema: RJSFSchema = { type: 'object', properties: { age: { type: 'integer' } } };

    const result = mergeImportedDataIntoSchema(schema, null, { data: { age: 'seventeen' } });

    expect(result.mergedData).toEqual({ age: 'seventeen' });
  });

  it('matches via x-wallet-aliases against the raw payload', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        full_name: { type: 'string', 'x-wallet-aliases': ['candidate name'] } as RJSFSchema,
      },
    };

    const result = mergeImportedDataIntoSchema(schema, null, {
      data: {},
      rawPayload: { credentialSubject: { 'candidate name': 'Asha Rao' } },
    });

    expect(result.mergedData).toEqual({ full_name: 'Asha Rao' });
    expect(result.mappedCount).toBe(1);
  });

  it('ignores non-array and blank alias extension values', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        full_name: {
          type: 'string',
          'x-import-aliases': 'candidate name',
          'x-import-paths': ['   ', 42],
        } as RJSFSchema,
      },
    };

    const result = mergeImportedDataIntoSchema(schema, null, {
      data: {},
      rawPayload: { credentialSubject: { 'candidate name': 'Asha Rao' } },
    });

    expect(result.mergedData).toEqual({});
    expect(result.mappedCount).toBe(0);
  });

  it('prefers the normalized data over supplied candidates over the raw payload', () => {
    const schema: RJSFSchema = { type: 'object', properties: { age: { type: 'integer' } } };

    const rawWins = mergeImportedDataIntoSchema(schema, null, {
      data: {},
      rawPayload: { age: 30 },
    });
    expect(rawWins.mergedData).toEqual({ age: 30 });

    const candidatesWin = mergeImportedDataIntoSchema(schema, null, {
      data: {},
      candidates: { age: 28 },
      rawPayload: { age: 30 },
    });
    expect(candidatesWin.mergedData).toEqual({ age: 28 });

    const dataWins = mergeImportedDataIntoSchema(schema, null, {
      data: { age: 25 },
      candidates: { age: 28 },
      rawPayload: { age: 30 },
    });
    expect(dataWins.mergedData).toEqual({ age: 25 });
  });

  it('does not map (and does not clear) a field whose payload value is an empty string', () => {
    const result = mergeImportedDataIntoSchema(stringSchema, { hobby: 'chess' }, {
      data: { hobby: '' },
    });

    expect(result.mergedData).toEqual({ hobby: 'chess' });
    expect(result.mappedCount).toBe(0);
    expect(result.skippedKeys).toEqual(['hobby']);
  });

  it('maps nothing when the schema declares no properties', () => {
    const result = mergeImportedDataIntoSchema({ type: 'object' }, null, {
      data: { full_name: 'Asha Rao' },
    });

    expect(result.mergedData).toEqual({});
    expect(result.mappedCount).toBe(0);
    expect(result.skippedKeys).toEqual(['full_name']);
  });
});

// ───────────────────────── geo/browser-location ─────────────────────────

type SuccessCallback = Parameters<Geolocation['getCurrentPosition']>[0];
type ErrorCallback = NonNullable<Parameters<Geolocation['getCurrentPosition']>[1]>;

function fakePosition(lat: number, lng: number, accuracy: number): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lng, accuracy },
    timestamp: 1_700_000_000_000,
  } as GeolocationPosition;
}

function fakeGeoError(code: number, message = ''): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('browser-location', () => {
  let getCurrentPosition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getCurrentPosition = vi.fn(
      (_success: SuccessCallback, _error?: ErrorCallback | null, _options?: PositionOptions) => {
        // Individual tests drive the callbacks via mock.calls.
      }
    );
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'geolocation');
    vi.unstubAllGlobals();
  });

  it('reports support based on navigator.geolocation being present', () => {
    expect(isBrowserLocationSupported()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(isBrowserLocationSupported()).toBe(false);
  });

  it('rejects with code "unsupported" when geolocation is missing', async () => {
    vi.stubGlobal('navigator', {});

    await expect(getBrowserLocation()).rejects.toMatchObject({
      name: 'BrowserLocationError',
      code: 'unsupported',
      message: 'Geolocation is not available in this browser.',
    });
  });

  it('resolves lat/lng/accuracy from the reported coords using default options', async () => {
    const pending = getBrowserLocation();
    const [success, , options] = getCurrentPosition.mock.calls[0] as [
      SuccessCallback,
      ErrorCallback,
      PositionOptions,
    ];
    success(fakePosition(12.97, 77.59, 25));

    await expect(pending).resolves.toEqual({ lat: 12.97, lng: 77.59, accuracy: 25 });
    expect(options).toEqual({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 });
  });

  it('forwards highAccuracy / timeoutMs / maxAgeMs to the browser API', async () => {
    const pending = getBrowserLocation({ highAccuracy: true, timeoutMs: 2_000, maxAgeMs: 60_000 });
    const [success, , options] = getCurrentPosition.mock.calls[0] as [
      SuccessCallback,
      ErrorCallback,
      PositionOptions,
    ];
    success(fakePosition(1, 2, 3));
    await pending;

    expect(options).toEqual({ enableHighAccuracy: true, timeout: 2_000, maximumAge: 60_000 });
  });

  it.each([
    [1, 'permission_denied', 'Location permission was denied.'],
    [2, 'position_unavailable', 'Your location could not be determined.'],
    [3, 'timeout', 'Timed out while determining your location.'],
  ])('maps browser error code %i to %s', async (code, expectedCode, expectedMessage) => {
    const pending = getBrowserLocation();
    const [, onError] = getCurrentPosition.mock.calls[0] as [SuccessCallback, ErrorCallback];
    onError(fakeGeoError(code));

    await expect(pending).rejects.toBeInstanceOf(BrowserLocationError);
    await expect(pending).rejects.toMatchObject({ code: expectedCode, message: expectedMessage });
  });

  it('falls back to position_unavailable for an unknown code, keeping the browser message', async () => {
    const pending = getBrowserLocation();
    const [, onError] = getCurrentPosition.mock.calls[0] as [SuccessCallback, ErrorCallback];
    onError(fakeGeoError(99, 'device is on fire'));

    await expect(pending).rejects.toMatchObject({
      code: 'position_unavailable',
      message: 'device is on fire',
    });
  });

  it('uses a generic message for an unknown code with no browser message', async () => {
    const pending = getBrowserLocation();
    const [, onError] = getCurrentPosition.mock.calls[0] as [SuccessCallback, ErrorCallback];
    onError(fakeGeoError(99, ''));

    await expect(pending).rejects.toMatchObject({
      code: 'position_unavailable',
      message: 'Failed to get the current location.',
    });
  });

  it('rejects immediately for an already-aborted signal without prompting the user', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(getBrowserLocation({ signal: controller.signal })).rejects.toMatchObject({
      code: 'timeout',
      message: 'Location request was aborted.',
    });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('rejects on mid-flight abort and ignores a late browser success callback', async () => {
    const controller = new AbortController();
    const pending = getBrowserLocation({ signal: controller.signal });
    const [success] = getCurrentPosition.mock.calls[0] as [SuccessCallback];

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });

    // Arriving after the abort, this must not flip the promise to resolved.
    success(fakePosition(12.97, 77.59, 25));
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('detaches the abort listener once a fix resolves', async () => {
    const controller = new AbortController();
    const pending = getBrowserLocation({ signal: controller.signal });
    const [success] = getCurrentPosition.mock.calls[0] as [SuccessCallback];
    success(fakePosition(5, 6, 7));
    await expect(pending).resolves.toEqual({ lat: 5, lng: 6, accuracy: 7 });

    // A later abort of the same controller must not throw or affect anything.
    expect(() => controller.abort()).not.toThrow();
  });
});

// ───────────────────────── geo/google-places ─────────────────────────

interface FakeAddressComponent {
  types: string[];
  longText: string;
  shortText: string;
}

interface FakePlace {
  fetchFields: ReturnType<typeof vi.fn>;
  location?: { lat: () => number; lng: () => number };
  addressComponents?: FakeAddressComponent[];
}

function component(types: string[], longText: string): FakeAddressComponent {
  return { types, longText, shortText: longText };
}

function fakePlace(
  coords: { lat: number; lng: number } | null,
  addressComponents?: FakeAddressComponent[]
): FakePlace {
  return {
    fetchFields: vi.fn((_req: { fields: string[] }) => Promise.resolve()),
    location: coords ? { lat: () => coords.lat, lng: () => coords.lng } : undefined,
    addressComponents,
  };
}

function fakeSuggestion(label: string, place: FakePlace) {
  return { placePrediction: { text: { toString: () => label }, toPlace: () => place } };
}

class FakeSessionToken {}

function stubGoogleMaps(suggestions: unknown[]) {
  const fetchAutocompleteSuggestions = vi.fn((_req: object) => Promise.resolve({ suggestions }));
  const importLibrary = vi.fn((_name: string) =>
    Promise.resolve({
      AutocompleteSessionToken: FakeSessionToken,
      AutocompleteSuggestion: { fetchAutocompleteSuggestions },
    } as Record<string, unknown>)
  );
  Object.defineProperty(window, 'google', {
    value: { maps: { importLibrary } },
    configurable: true,
    writable: true,
  });
  return { importLibrary, fetchAutocompleteSuggestions };
}

async function loadGooglePlaces() {
  vi.resetModules();
  return import('../geo/google-places');
}

describe('createGooglePlacesProvider', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'google');
    Reflect.deleteProperty(window, '__dpgGoogleMapsInit');
    document.head.querySelectorAll('script[data-dpg-google-maps="true"]').forEach((el) => {
      el.remove();
    });
    vi.restoreAllMocks();
  });

  it('returns no suggestions for a blank query without loading the Maps API', async () => {
    const { importLibrary } = stubGoogleMaps([]);
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    await expect(createGooglePlacesProvider('key-1').suggest('   ')).resolves.toEqual([]);
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it('resolves the top five predictions into labelled lat/lng suggestions', async () => {
    const places = Array.from({ length: 6 }, (_, i) =>
      fakePlace({ lat: 12 + i, lng: 77 + i }, [component(['locality'], `City ${i}`)])
    );
    const { importLibrary, fetchAutocompleteSuggestions } = stubGoogleMaps(
      places.map((p, i) => fakeSuggestion(`Place ${i}`, p))
    );
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    const results = await createGooglePlacesProvider('key-1').suggest('  bengal  ');

    expect(importLibrary).toHaveBeenCalledWith('places');
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ label: 'Place 0', lat: 12, lng: 77 });
    expect(results[4]).toMatchObject({ label: 'Place 4', lat: 16, lng: 81 });
    // The 6th prediction is dropped, so its fields are never fetched.
    expect(places[5].fetchFields).not.toHaveBeenCalled();
    expect(places[0].fetchFields).toHaveBeenCalledWith({
      fields: ['location', 'addressComponents'],
    });

    const request = fetchAutocompleteSuggestions.mock.calls[0][0] as {
      input: string;
      sessionToken: unknown;
    };
    expect(request.input).toBe('bengal');
    expect(request.sessionToken).toBeInstanceOf(FakeSessionToken);
  });

  it('maps Google address components onto the geo component fields', async () => {
    stubGoogleMaps([
      fakeSuggestion(
        'Indiranagar, Bengaluru',
        fakePlace({ lat: 12.97, lng: 77.64 }, [
          component(['sublocality', 'sublocality_level_1'], 'Indiranagar'),
          component(['locality'], 'Bengaluru'),
          component(['administrative_area_level_1'], 'Karnataka'),
          component(['postal_code'], '560038'),
          component(['country'], 'India'),
        ])
      ),
    ]);
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    const [result] = await createGooglePlacesProvider('key-1').suggest('indiranagar');

    expect(result.components).toEqual({
      locality: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postcode: '560038',
      country: 'India',
    });
  });

  it('falls back to locality for the area and to the district for the city', async () => {
    stubGoogleMaps([
      fakeSuggestion(
        'Mysuru',
        fakePlace({ lat: 12.3, lng: 76.6 }, [component(['locality'], 'Mysuru')])
      ),
      fakeSuggestion(
        'Mysuru District',
        fakePlace({ lat: 12.4, lng: 76.7 }, [
          component(['administrative_area_level_2'], 'Mysuru District'),
        ])
      ),
    ]);
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    const results = await createGooglePlacesProvider('key-1').suggest('mysuru');

    expect(results[0].components).toMatchObject({ locality: 'Mysuru', city: 'Mysuru' });
    expect(results[1].components).toMatchObject({
      locality: undefined,
      city: 'Mysuru District',
    });
  });

  it('drops predictions that resolve without a location', async () => {
    stubGoogleMaps([
      fakeSuggestion('No coords', fakePlace(null)),
      fakeSuggestion('Has coords', fakePlace({ lat: 1, lng: 2 })),
    ]);
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    const results = await createGooglePlacesProvider('key-1').suggest('anything');

    expect(results.map((r) => r.label)).toEqual(['Has coords']);
    expect(results[0].components).toEqual({
      locality: undefined,
      city: undefined,
      state: undefined,
      postcode: undefined,
      country: undefined,
    });
  });

  it('returns nothing and skips field fetches when the signal is already aborted', async () => {
    const place = fakePlace({ lat: 1, lng: 2 });
    stubGoogleMaps([fakeSuggestion('Place', place)]);
    const { createGooglePlacesProvider } = await loadGooglePlaces();
    const controller = new AbortController();
    controller.abort();

    const results = await createGooglePlacesProvider('key-1').suggest('bengal', controller.signal);

    expect(results).toEqual([]);
    expect(place.fetchFields).not.toHaveBeenCalled();
  });

  it('swallows Maps API failures and returns an empty list', async () => {
    const importLibrary = vi.fn((_name: string) => Promise.reject(new Error('quota exceeded')));
    Object.defineProperty(window, 'google', {
      value: { maps: { importLibrary } },
      configurable: true,
      writable: true,
    });
    const { createGooglePlacesProvider } = await loadGooglePlaces();

    await expect(createGooglePlacesProvider('key-1').suggest('bengal')).resolves.toEqual([]);
  });

  it('injects the Maps script with the api key and places library, then resolves via the callback', async () => {
    const appended: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      appended.push(node as HTMLScriptElement);
      return node;
    }) as typeof document.head.appendChild);

    const { createGooglePlacesProvider } = await loadGooglePlaces();
    const pending = createGooglePlacesProvider('maps-key-42').suggest('bengal');
    await Promise.resolve();

    expect(appended).toHaveLength(1);
    const script = appended[0];
    const url = new URL(script.src);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/js');
    expect(url.searchParams.get('key')).toBe('maps-key-42');
    expect(url.searchParams.get('libraries')).toBe('places');
    expect(url.searchParams.get('callback')).toBe('__dpgGoogleMapsInit');
    expect(url.searchParams.get('loading')).toBe('async');
    expect(script.async).toBe(true);
    expect(script.dataset.dpgGoogleMaps).toBe('true');

    // The Maps callback fires once the script has evaluated and window.google exists.
    stubGoogleMaps([fakeSuggestion('Bengaluru', fakePlace({ lat: 12.97, lng: 77.59 }))]);
    (window as unknown as { __dpgGoogleMapsInit: () => void }).__dpgGoogleMapsInit();

    await expect(pending).resolves.toMatchObject([{ label: 'Bengaluru', lat: 12.97, lng: 77.59 }]);
  });

  it('returns an empty list when the injected script fails to load', async () => {
    const appended: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      appended.push(node as HTMLScriptElement);
      return node;
    }) as typeof document.head.appendChild);

    const { createGooglePlacesProvider } = await loadGooglePlaces();
    const pending = createGooglePlacesProvider('maps-key-42').suggest('bengal');
    await Promise.resolve();

    appended[0].onerror?.(new Event('error'));

    await expect(pending).resolves.toEqual([]);
  });

  it('reuses an already-present Maps script tag instead of injecting a second one', async () => {
    const existing = document.createElement('script');
    existing.dataset.dpgGoogleMaps = 'true';
    document.head.appendChild(existing);
    const appendSpy = vi.spyOn(document.head, 'appendChild');

    const { createGooglePlacesProvider } = await loadGooglePlaces();
    const pending = createGooglePlacesProvider('maps-key-42').suggest('bengal');
    await Promise.resolve();

    expect(appendSpy).not.toHaveBeenCalled();

    stubGoogleMaps([fakeSuggestion('Bengaluru', fakePlace({ lat: 12.97, lng: 77.59 }))]);
    existing.dispatchEvent(new Event('load'));

    await expect(pending).resolves.toMatchObject([{ label: 'Bengaluru' }]);
  });
});

// ───────────────────────── wallet-api ─────────────────────────

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function brokenJsonResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

async function loadWalletApi(env: { url?: string; apiKey?: string }) {
  vi.resetModules();
  vi.stubEnv('VITE_VC_WALLET_URL', env.url ?? '');
  vi.stubEnv('VITE_VC_WALLET_API_KEY', env.apiKey ?? '');
  return import('../wallet-api');
}

describe('wallet-api configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('exposes no client and reports unconfigured when the wallet URL is absent', async () => {
    const mod = await loadWalletApi({ apiKey: 'key' });

    expect(mod.walletApi).toBeNull();
    expect(mod.isWalletConfigured()).toBe(false);
  });

  it('reports unconfigured when the URL is set but the api key is missing', async () => {
    const mod = await loadWalletApi({ url: 'https://wallet.test' });

    expect(mod.walletApi).not.toBeNull();
    expect(mod.isWalletConfigured()).toBe(false);
  });

  it('reports configured when both URL and api key are present', async () => {
    const mod = await loadWalletApi({ url: 'https://wallet.test', apiKey: 'key' });

    expect(mod.isWalletConfigured()).toBe(true);
  });
});

describe('wallet-api requests', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function setup(response: Response = jsonResponse({ message: 'ok' })) {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(response));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadWalletApi({ url: 'https://wallet.test', apiKey: 'secret-key' });
    if (!mod.walletApi) throw new Error('walletApi should be configured in this test');
    return { api: mod.walletApi, fetchMock };
  }

  function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return init.headers as Record<string, string>;
  }

  it('POSTs an OTP request without the api key or bearer token', async () => {
    const { api, fetchMock } = await setup(jsonResponse({ message: 'code sent' }));

    await expect(api.requestCode('asha@example.com', 'email')).resolves.toEqual({
      message: 'code sent',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://wallet.test/api/v1/auth/request-code');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ identifier: 'asha@example.com', type: 'email' }));
    expect(headersOf(fetchMock)).toEqual({ 'Content-Type': 'application/json' });
  });

  it('POSTs the OTP verification and returns the issued token', async () => {
    const { api, fetchMock } = await setup(jsonResponse({ message: 'ok', token: 'tok-1' }));

    await expect(api.verifyCode('+919876543210', '123456')).resolves.toEqual({
      message: 'ok',
      token: 'tok-1',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://wallet.test/api/v1/auth/verify-code');
  });

  it('sends the api key and bearer token when listing verified credentials', async () => {
    const { api, fetchMock } = await setup(jsonResponse({ total: 0, credentials: [] }));
    api.setAuthToken('tok-1');

    await expect(api.getVerifiedCredentials('asha+1@example.com')).resolves.toEqual({
      total: 0,
      credentials: [],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://wallet.test/api/v1/verified-credentials?identifier=asha%2B1%40example.com&page=1&limit=50'
    );
    expect(headersOf(fetchMock)).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'secret-key',
      Authorization: 'Bearer tok-1',
    });
  });

  it('drops the bearer token after clearAuthToken', async () => {
    const { api, fetchMock } = await setup(jsonResponse({ total: 0, credentials: [] }));
    api.setAuthToken('tok-1');
    api.clearAuthToken();

    await api.getVerifiedCredentials('asha@example.com');

    expect(headersOf(fetchMock)).not.toHaveProperty('Authorization');
    expect(headersOf(fetchMock)['x-api-key']).toBe('secret-key');
  });

  it("surfaces the wallet's error message on a failed request", async () => {
    const { api } = await setup(
      jsonResponse({ message: 'Invalid code' }, { ok: false, status: 400 })
    );

    await expect(api.verifyCode('asha@example.com', '000000')).rejects.toThrow('Invalid code');
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const { api } = await setup(brokenJsonResponse(503));

    await expect(api.requestCode('asha@example.com', 'email')).rejects.toThrow('HTTP error 503');
  });
});

describe('wallet-api transformSelectedCredential', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds import candidates, metadata and a human summary from the credential', async () => {
    const mod = await loadWalletApi({ url: 'https://wallet.test', apiKey: 'secret-key' });
    const api = mod.walletApi;
    if (!api) throw new Error('walletApi should be configured in this test');

    const result = api.transformSelectedCredential(
      { id: 7, metadata: { orgName: 'Dhiway' }, credentials: [] },
      {
        id: 'cred-1',
        credentialSchema: { title: 'Marksheet' },
        credentialSubject: { fullName: 'Asha Rao', marks: 92 },
      }
    );

    expect(result.summary).toBe('Marksheet from Dhiway');
    expect(result.metadata).toEqual({
      credentialId: 'cred-1',
      schemaTitle: 'Marksheet',
      orgName: 'Dhiway',
      provider: 'dhiway-wallet',
    });
    expect(result.data).toEqual({});
    expect(result.candidates.fullName).toBe('Asha Rao');
    expect(result.candidates.full_name).toBe('Asha Rao');
    expect(result.candidates.marks).toBe(92);
    expect(result.rawPayload).toMatchObject({
      credentialSubject: { fullName: 'Asha Rao', marks: 92 },
      metadata: { orgName: 'Dhiway' },
    });
  });

  it('falls back to "Credential" / "wallet" when the schema title and org name are missing', async () => {
    const mod = await loadWalletApi({ url: 'https://wallet.test', apiKey: 'secret-key' });
    const api = mod.walletApi;
    if (!api) throw new Error('walletApi should be configured in this test');

    const result = api.transformSelectedCredential(
      { id: 7, credentials: [] },
      { id: 'cred-2', credentialSchema: { title: 42 } }
    );

    expect(result.summary).toBe('Credential from wallet');
    expect(result.metadata).toMatchObject({ schemaTitle: 'Credential', orgName: 'wallet' });
    expect(result.rawPayload).toMatchObject({ credentialSubject: {}, metadata: {} });
  });

  it('feeds wallet candidates straight into schema mapping', async () => {
    const mod = await loadWalletApi({ url: 'https://wallet.test', apiKey: 'secret-key' });
    const api = mod.walletApi;
    if (!api) throw new Error('walletApi should be configured in this test');

    const transformed = api.transformSelectedCredential(
      { id: 7, metadata: { orgName: 'Dhiway' }, credentials: [] },
      { id: 'cred-1', credentialSubject: { fullName: 'Asha Rao', marks: '92' } }
    );

    const schema: RJSFSchema = {
      type: 'object',
      properties: { full_name: { type: 'string' }, marks: { type: 'integer' } },
    };
    const merged = mergeImportedDataIntoSchema(schema, null, transformed);

    expect(merged.mergedData).toEqual({ full_name: 'Asha Rao', marks: 92 });
    expect(merged.mappedCount).toBe(2);
  });
});

// ───────────────────────── consent-api ─────────────────────────

type ConsentApi = typeof import('../consent-api');

async function loadConsentApi(response: unknown) {
  vi.resetModules();
  const get = vi.fn((_url: string, _config?: unknown) => Promise.resolve({ data: response }));
  const post = vi.fn((_url: string, _body?: unknown) => Promise.resolve({ data: response }));
  vi.doMock('../api-client', () => ({ createApiClient: () => ({ get, post }) }));
  const api = await import('../consent-api');
  return { api, get, post };
}

const acceptBody: ConsentAcceptBody = {
  network: 'blue_dot',
  brand: 'upsdm',
  source: 'signup',
  items: [{ category: 'terms', version: 2 }],
};

const profileAcceptBody: ProfileConsentAcceptBody = {
  network: 'blue_dot',
  brand: null,
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_id: '11111111-2222-3333-4444-555555555555',
  version: 1,
};

const itemRef = {
  network: 'blue_dot',
  brand: 'upsdm',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_id: 'item-1',
};

const precreateRef = { network: 'blue_dot', brand: 'upsdm', item_domain: 'student' };

describe('consent-api config and status reads', () => {
  it('fetchConsentConfigs keeps only consent_config entries and normalizes a missing brand', async () => {
    const { api, get } = await loadConsentApi([
      { kind: 'network', schema: { id: 'net' } },
      { kind: 'consent_config', brand: 'upsdm', schema: { version: 3 } },
      { kind: 'consent_config', schema: { version: 1 } },
    ]);

    await expect(api.fetchConsentConfigs('blue_dot')).resolves.toEqual([
      { brand: 'upsdm', schema: { version: 3 } },
      { brand: null, schema: { version: 1 } },
    ]);
    expect(get).toHaveBeenCalledWith('/api/v1/network/schemas', {
      params: { network: 'blue_dot' },
    });
  });

  it('getConsentStatus reads the accepted versions for the network', async () => {
    const statuses = { statuses: { terms: [2], privacy: [1] } };
    const { api, get } = await loadConsentApi(statuses);

    await expect(api.getConsentStatus('blue_dot')).resolves.toEqual(statuses);
    expect(get).toHaveBeenCalledWith('/api/v1/consent/status', {
      params: { network: 'blue_dot' },
    });
  });

  it('getConsentStatusByIdentifier forwards phone/email as query params', async () => {
    const statuses = { statuses: { terms: [], privacy: [] } };
    const { api, get } = await loadConsentApi(statuses);
    const params = { network: 'blue_dot', phone: '+919876543210' };

    await expect(api.getConsentStatusByIdentifier(params)).resolves.toEqual(statuses);
    expect(get).toHaveBeenCalledWith('/api/v1/consent/status-by-identifier', { params });
  });

  it('getProfileConsentStatus returns the consented item ids', async () => {
    const { api, get } = await loadConsentApi({ consented_item_ids: ['item-1'] });

    await expect(api.getProfileConsentStatus('blue_dot')).resolves.toEqual({
      consented_item_ids: ['item-1'],
    });
    expect(get).toHaveBeenCalledWith('/api/v1/consent/profile-status', {
      params: { network: 'blue_dot' },
    });
  });

  it('getU18Status reads the stored minor/guardian flags', async () => {
    const status = { hasBirthData: true, isMinor: true, guardianVerified: false };
    const { api, get } = await loadConsentApi(status);

    await expect(api.getU18Status('blue_dot')).resolves.toEqual(status);
    expect(get).toHaveBeenCalledWith('/api/v1/consent/u18/status', {
      params: { network: 'blue_dot' },
    });
  });
});

describe('consent-api writes', () => {
  const cases: Array<{
    name: string;
    endpoint: string;
    body: Record<string, unknown>;
    data: Record<string, unknown>;
    call: (api: ConsentApi) => Promise<unknown>;
  }> = [
    {
      name: 'acceptConsent',
      endpoint: '/api/v1/consent/accept',
      body: acceptBody,
      data: { recorded: 1 },
      call: (api) => api.acceptConsent(acceptBody),
    },
    {
      name: 'acceptProfileConsent',
      endpoint: '/api/v1/consent/profile-accept',
      body: profileAcceptBody,
      data: { recorded: 1 },
      call: (api) => api.acceptProfileConsent(profileAcceptBody),
    },
    {
      name: 'startSignupGuardian',
      endpoint: '/api/v1/consent/u18/signup/guardian',
      body: {
        network: 'blue_dot',
        domain: 'student',
        email: 'ward@example.com',
        age: 15,
        guardianName: 'Asha Guardian',
        guardianPhone: '+919876543210',
        guardianDeclarationAccepted: true,
      },
      data: { otpSent: true },
      call: (api) =>
        api.startSignupGuardian({
          network: 'blue_dot',
          domain: 'student',
          email: 'ward@example.com',
          age: 15,
          guardianName: 'Asha Guardian',
          guardianPhone: '+919876543210',
          guardianDeclarationAccepted: true,
        }),
    },
    {
      name: 'verifySignupGuardian',
      endpoint: '/api/v1/consent/u18/signup/guardian/verify',
      body: { network: 'blue_dot', email: 'ward@example.com', otp: '123456' },
      data: { verified: true },
      call: (api) =>
        api.verifySignupGuardian({
          network: 'blue_dot',
          email: 'ward@example.com',
          otp: '123456',
        }),
    },
    {
      name: 'issueProfilePrecreateOtp',
      endpoint: '/api/v1/consent/u18/profile-consent/precreate/issue',
      body: precreateRef,
      data: { otpSent: true },
      call: (api) => api.issueProfilePrecreateOtp(precreateRef),
    },
    {
      name: 'verifyProfilePrecreateOtp',
      endpoint: '/api/v1/consent/u18/profile-consent/precreate/verify',
      body: { ...precreateRef, otp: '123456' },
      data: { verified: true },
      call: (api) => api.verifyProfilePrecreateOtp({ ...precreateRef, otp: '123456' }),
    },
    {
      name: 'finalizeProfileConsent',
      endpoint: '/api/v1/consent/u18/profile-consent/finalize',
      body: itemRef,
      data: { promoted: true },
      call: (api) => api.finalizeProfileConsent(itemRef),
    },
  ];

  it.each(cases)('$name POSTs to $endpoint and returns the parsed body', async (testCase) => {
    const { api, post } = await loadConsentApi(testCase.data);

    await expect(testCase.call(api)).resolves.toEqual(testCase.data);
    expect(post).toHaveBeenCalledWith(testCase.endpoint, testCase.body);
  });

  it('propagates a rejected request to the caller', async () => {
    vi.resetModules();
    const post = vi.fn((_url: string, _body?: unknown) =>
      Promise.reject(new Error('OTP_INVALID'))
    );
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ get: vi.fn(), post }),
    }));
    const api = await import('../consent-api');

    await expect(
      api.verifyProfilePrecreateOtp({ ...precreateRef, otp: '000000' })
    ).rejects.toThrow('OTP_INVALID');
  });
});
