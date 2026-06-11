import { describe, it, expect } from 'vitest';
import type { MapMarker } from '@/engine/types';
import { iconForCategory, resolvePractitionerIcon, CATEGORY_FALLBACK_ICON } from './category-icons';

describe('iconForCategory', () => {
  it('returns a distinct, non-fallback icon for each known category', () => {
    const categories = ['Stay', 'Artists', 'Activities', 'GI Products', 'Curated'];
    const icons = categories.map(iconForCategory);
    // All five distinct
    expect(new Set(icons).size).toBe(categories.length);
    // None is the fallback
    icons.forEach((icon) => expect(icon).not.toBe(CATEGORY_FALLBACK_ICON));
  });

  it('falls back for unknown, empty, or non-string categories', () => {
    expect(iconForCategory('Nonexistent')).toBe(CATEGORY_FALLBACK_ICON);
    expect(iconForCategory('')).toBe(CATEGORY_FALLBACK_ICON);
    expect(iconForCategory(undefined)).toBe(CATEGORY_FALLBACK_ICON);
    expect(iconForCategory(42)).toBe(CATEGORY_FALLBACK_ICON);
  });
});

describe('resolvePractitionerIcon', () => {
  it('reads the icon from marker.data.category', () => {
    const marker = {
      id: 'p1',
      lat: 13.34,
      lng: 74.74,
      label: 'X',
      precision: 'exact',
      data: { category: 'Stay' },
    } as unknown as MapMarker;
    expect(resolvePractitionerIcon(marker)).toBe(iconForCategory('Stay'));
  });

  it('falls back when the marker has no category', () => {
    const marker = {
      id: 'p2',
      lat: 13.34,
      lng: 74.74,
      label: 'Y',
      precision: 'exact',
      data: {},
    } as unknown as MapMarker;
    expect(resolvePractitionerIcon(marker)).toBe(CATEGORY_FALLBACK_ICON);
  });
});
