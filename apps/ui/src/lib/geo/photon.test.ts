import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPhotonProvider } from './photon';

function feature(name: string, countrycode: string, type = 'city') {
  return {
    geometry: { coordinates: [77, 12] },
    properties: { name, country: countrycode, countrycode, type },
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

function respond(features: unknown[]) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ features }), { status: 200 }));
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('createPhotonProvider country restriction (#788)', () => {
  it('adds countrycode to the request when a country is set', async () => {
    respond([]);
    await createPhotonProvider('https://photon.example', 'IN').suggest('Dhaka');
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('countrycode')).toBe('IN');
    expect(url.searchParams.get('q')).toBe('Dhaka');
  });

  it('sends no countrycode when no country is set', async () => {
    respond([]);
    await createPhotonProvider('https://photon.example').suggest('Dhaka');
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.has('countrycode')).toBe(false);
  });

  it('drops foreign and country/state-level features as a backstop', async () => {
    respond([
      feature('Dhaka BD', 'BD'),
      feature('India', 'IN', 'country'),
      feature('Bihar', 'IN', 'state'),
      feature('Dhaka IN', 'IN'),
    ]);
    const out = await createPhotonProvider('https://photon.example', 'IN').suggest('Dhaka');
    expect(out.map((s) => s.components?.locality)).toEqual(['Dhaka IN']);
  });

  it('keeps every feature when no country is set', async () => {
    respond([feature('Dhaka BD', 'BD'), feature('Dhaka IN', 'IN')]);
    const out = await createPhotonProvider('https://photon.example').suggest('Dhaka');
    expect(out).toHaveLength(2);
  });
});
