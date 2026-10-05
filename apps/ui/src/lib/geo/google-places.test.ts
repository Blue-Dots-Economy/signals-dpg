import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGooglePlacesProvider } from './google-places';

type Component = { types: string[]; longText: string; shortText: string };

function prediction(label: string, countryCode: string) {
  const addressComponents: Component[] = [
    { types: ['locality'], longText: label, shortText: label },
    { types: ['country'], longText: countryCode, shortText: countryCode },
  ];
  return {
    placePrediction: {
      text: { toString: () => label },
      toPlace: () => ({
        fetchFields: vi.fn().mockResolvedValue(undefined),
        location: { lat: () => 1, lng: () => 2 },
        addressComponents,
      }),
    },
  };
}

const fetchAutocompleteSuggestions = vi.fn();

beforeEach(() => {
  fetchAutocompleteSuggestions.mockReset();
  (window as unknown as { google: unknown }).google = {
    maps: {
      importLibrary: vi.fn().mockResolvedValue({
        AutocompleteSessionToken: class {},
        AutocompleteSuggestion: { fetchAutocompleteSuggestions },
      }),
    },
  };
});

describe('createGooglePlacesProvider country restriction (#785)', () => {
  it('sends includedRegionCodes when a country is set', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [] });
    await createGooglePlacesProvider('k', 'IN').suggest('Dharwad');
    expect(fetchAutocompleteSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'Dharwad', includedRegionCodes: ['in'] }),
    );
  });

  it('sends no includedRegionCodes when no country is set', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [] });
    await createGooglePlacesProvider('k').suggest('Dharwad');
    expect(fetchAutocompleteSuggestions.mock.calls[0]![0]).not.toHaveProperty('includedRegionCodes');
  });

  it('drops a suggestion from another country as a backstop', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({
      suggestions: [prediction('Bogura, Bangladesh', 'BD'), prediction('Bogura, India', 'IN')],
    });
    const out = await createGooglePlacesProvider('k', 'IN').suggest('Bogura');
    expect(out.map((s) => s.label)).toEqual(['Bogura, India']);
  });

  it('keeps every suggestion when no country is set', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({
      suggestions: [prediction('Bogura, Bangladesh', 'BD'), prediction('Bogura, India', 'IN')],
    });
    const out = await createGooglePlacesProvider('k').suggest('Bogura');
    expect(out).toHaveLength(2);
  });
});
