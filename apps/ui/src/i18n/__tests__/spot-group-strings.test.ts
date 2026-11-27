import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import hi from '../locales/hi.json';
import kn from '../locales/kn.json';

const KEYS = [
  'home.search_this_area',
  'map.spot_title_exact',
  'map.spot_title_near',
  'map.spot_body_exact',
  'map.spot_body_near',
  'map.spot_view_in_list',
  'map.spot_type_count',
  'map.spot_close',
  'browse.area_spot_exact',
  'browse.area_spot_near',
  'browse.spot_banner_exact',
  'browse.spot_banner_near',
  'browse.spot_back_to_map',
] as const;

const locales = { en, hi, kn } as unknown as Record<string, Record<string, string>>;

describe('same-spot strings', () => {
  it.each(Object.keys(locales))('are all present in %s', (code) => {
    for (const key of KEYS) expect(locales[code][key], `${code}: ${key}`).toBeTruthy();
  });

  it('keep the {{n}} placeholder in every translation that counts', () => {
    for (const code of Object.keys(locales)) {
      for (const key of ['map.spot_title_exact', 'map.spot_title_near', 'map.spot_view_in_list', 'map.spot_type_count']) {
        expect(locales[code][key], `${code}: ${key}`).toContain('{{n}}');
      }
    }
  });

  it('names the map button for listing what is in view', () => {
    expect(en['home.search_this_area']).toBe("List what's in this view");
  });
});
