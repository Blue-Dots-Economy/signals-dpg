/**
 * Resolves non-CSS brand metadata (favicon type, logo shape, copy) by
 * merging a network's base brand.json fields with the active brand's
 * override. Brand wins; absent fields fall back to network base, then
 * to safe defaults. Sourced from the build-time __BRAND_REGISTRY__.
 */
export type FaviconType = 'png' | 'svg';
/**
 * How the brand's mark is proportioned, which drives its rendered height.
 *
 *  - `wordmark` ~5:1  — a wide horizontal wordmark (the blue/purple marks)
 *  - `lockup`   ~3:1  — a wordmark stacked over a strapline; at wordmark
 *                       height the strapline line is too small to read
 *  - `square`   ~1:1  — a compact mark that needs the most height
 */
export type LogoShape = 'square' | 'wordmark' | 'lockup';

export interface BrandMeta {
  faviconType: FaviconType;
  logoShape: LogoShape;
  copy: Record<string, string>;
}

type Entry = {
  faviconType?: FaviconType;
  logoShape?: LogoShape;
  copy?: Record<string, string>;
  brands?: Record<string, { faviconType?: FaviconType; logoShape?: LogoShape; copy?: Record<string, string> }>;
};
export type BrandRegistry = Record<string, Entry>;

export function resolveBrandMeta(
  networkId: string,
  brandSlug: string,
  registry: BrandRegistry = typeof __BRAND_REGISTRY__ !== 'undefined' ? __BRAND_REGISTRY__ : {},
): BrandMeta {
  const net = registry[networkId];
  const brand = net?.brands?.[brandSlug];
  return {
    faviconType: brand?.faviconType ?? net?.faviconType ?? 'svg',
    logoShape: brand?.logoShape ?? net?.logoShape ?? 'wordmark',
    copy: { ...(net?.copy ?? {}), ...(brand?.copy ?? {}) },
  };
}
