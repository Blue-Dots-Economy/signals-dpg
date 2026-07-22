import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalsSearchClient } from '../../../../../packages/match_score/src/providers/signals_search/client';
import type { MatchScoreRequest } from '../../../../../packages/match_score/src/match_score.types';

const item = (id: string) => ({
  item_network: 'blue_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
  item_id: id,
  item_instance_url: 'https://instance/item',
  item_schema_url: 'https://instance/schema',
  item_state: { headline: 'plumber' },
  item_latitude: 12.9,
  item_longitude: 77.6,
});
const req: MatchScoreRequest = { itemA: item('a'), itemB: item('b') };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SignalsSearchClient', () => {
  it('POSTs item PKs to /v1/relevance with x-api-key and maps percentage → 0-10 score', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ score: 87.34 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    const result = await client.calculate(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe('http://search:3100/v1/relevance');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['x-api-key']).toBe('sk_test');
    // Only the composite PK is sent — no item_state / coordinates.
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      itemA: { item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'a' },
      itemB: { item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'b' },
    });

    expect(result.provider).toBe('signals_search');
    expect(result.score).toBeCloseTo(8.734, 5); // 87.34% → 0-10 scale
    expect(result.raw_response).toEqual({ score: 87.34 });
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    await expect(client.calculate(req)).rejects.toThrow(/Match score service error 404/);
  });

  it('honors a custom path override', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ score: 50 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'k', path: 'v2/relevance' });
    await client.calculate(req);
    expect(capturedUrl).toBe('http://search:3100/v2/relevance');
  });
});
