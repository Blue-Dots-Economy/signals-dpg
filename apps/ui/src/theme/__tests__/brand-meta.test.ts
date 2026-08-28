import { describe, it, expect } from 'vitest';
import { resolveBrandMeta } from '../brand-meta';

const registry = {
  blue_dot: {
    faviconType: 'svg', logoShape: 'wordmark', copy: { title: 'Blue Dots' },
    brands: { upsdm: { faviconType: 'png', logoShape: 'square', copy: { title: 'UPSDM' } } },
  },
  orange_dot: { faviconType: 'svg', logoShape: 'wordmark', brands: {} },
} as const;

describe('resolveBrandMeta', () => {
  it('returns network base for standard brand', () => {
    expect(resolveBrandMeta('blue_dot', 'standard', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: { title: 'Blue Dots' },
      footerLogo: null, footerLogoLight: null,
    });
  });
  it('merges brand override over network base', () => {
    expect(resolveBrandMeta('blue_dot', 'upsdm', registry as any)).toEqual({
      faviconType: 'png', logoShape: 'square', copy: { title: 'UPSDM' },
      footerLogo: null, footerLogoLight: null,
    });
  });
  it('falls back to defaults for unknown network', () => {
    expect(resolveBrandMeta('ghost_dot', 'x', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: {},
      footerLogo: null, footerLogoLight: null,
    });
  });
  it('unknown brand uses network base', () => {
    expect(resolveBrandMeta('orange_dot', 'nope', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: {},
      footerLogo: null, footerLogoLight: null,
    });
  });
});
