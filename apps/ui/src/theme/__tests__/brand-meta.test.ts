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

  it('resolves a network-level footer logo', () => {
    const reg = {
      blue_dot: { footerLogo: '/brand/ekstep.png', footerLogoLight: '/brand/ekstep-light.png' },
    };
    const m = resolveBrandMeta('blue_dot', 'standard', reg as any);
    expect(m.footerLogo).toBe('/brand/ekstep.png');
    expect(m.footerLogoLight).toBe('/brand/ekstep-light.png');
  });

  it('lets a brand override the footer logo', () => {
    const reg = {
      blue_dot: {
        footerLogo: '/brand/ekstep.png',
        brands: { upsdm: { footerLogo: '/brand/upsdm.png' } },
      },
    };
    expect(resolveBrandMeta('blue_dot', 'upsdm', reg as any).footerLogo).toBe('/brand/upsdm.png');
  });

  it('does NOT inherit the network footer logo onto a brand that omits it', () => {
    // up-gzb / ka-dhwd: a real brand with no footerLogo must hide the mark,
    // even though the blue_dot network sets one.
    const reg = {
      blue_dot: {
        footerLogo: '/brand/ekstep.png',
        footerLogoLight: '/brand/ekstep-light.png',
        brands: { 'up-gzb': { logoShape: 'lockup' } },
      },
    };
    const m = resolveBrandMeta('blue_dot', 'up-gzb', reg as any);
    expect(m.footerLogo).toBeNull();
    expect(m.footerLogoLight).toBeNull();
    // the plain network default still shows it
    expect(resolveBrandMeta('blue_dot', 'standard', reg as any).footerLogo).toBe('/brand/ekstep.png');
  });
});
