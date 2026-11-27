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

/**
 * One labelled party in the sidebar footer's attribution block ("Owned by
 * Swavalambhan", "Managed by ALIMCO"). Unlike the single unlabelled
 * `footerLogo`, this is an ordered list with a caption per entry. `logo` is
 * optional: a name alone renders a letter tile until artwork arrives.
 */
export interface BrandAttribution {
  /** Caption above the party, e.g. `Owned by`. */
  label: string;
  /** Display name, and the source of the fallback initial. */
  name: string;
  /** Optional mark. Omit to render a letter tile. */
  logo?: string;
  /** Optional dark-mode variant, mirroring `footerLogoLight`. */
  logoLight?: string;
}

export interface BrandMeta {
  faviconType: FaviconType;
  logoShape: LogoShape;
  copy: Record<string, string>;
  /**
   * Optional "seeded by" mark at the bottom of the sidebar; null means none.
   * Opt-in via brand.json's `footerLogo` / `footerLogoLight` (light = the
   * dark-mode variant).
   */
  footerLogo: string | null;
  footerLogoLight: string | null;
  /** Ordered attribution rows, or null when the brand declares none. */
  footerAttribution: BrandAttribution[] | null;
}

type MetaFields = {
  faviconType?: FaviconType;
  logoShape?: LogoShape;
  copy?: Record<string, string>;
  footerLogo?: string;
  footerLogoLight?: string;
  footerAttribution?: BrandAttribution[];
};
type Entry = MetaFields & {
  brands?: Record<string, MetaFields>;
};
export type BrandRegistry = Record<string, Entry>;

export function resolveBrandMeta(
  networkId: string,
  brandSlug: string,
  registry: BrandRegistry = typeof __BRAND_REGISTRY__ !== 'undefined' ? __BRAND_REGISTRY__ : {},
): BrandMeta {
  const net = registry[networkId];
  const brand = net?.brands?.[brandSlug];
  // footerLogo and footerAttribution do not inherit network → brand (unlike
  // favicon/logoShape/copy). An active brand shows them only if it sets its
  // own; the network's values apply only with no brand entry. Attribution
  // names who owns this deployment, so inheriting it would credit the wrong
  // party.
  const footerFromBrand = brand
    ? {
        footerLogo: brand.footerLogo ?? null,
        footerLogoLight: brand.footerLogoLight ?? null,
        footerAttribution: brand.footerAttribution ?? null,
      }
    : {
        footerLogo: net?.footerLogo ?? null,
        footerLogoLight: net?.footerLogoLight ?? null,
        footerAttribution: net?.footerAttribution ?? null,
      };
  return {
    faviconType: brand?.faviconType ?? net?.faviconType ?? 'svg',
    logoShape: brand?.logoShape ?? net?.logoShape ?? 'wordmark',
    copy: { ...(net?.copy ?? {}), ...(brand?.copy ?? {}) },
    ...footerFromBrand,
  };
}
