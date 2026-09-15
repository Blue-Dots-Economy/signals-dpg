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
 * One labelled party in the sidebar footer's attribution block — "Owned by
 * Swavalambhan", "Managed by ALIMCO" (signals-dpg#720).
 *
 * Separate from `footerLogo`, which is a single unlabelled "seeded by" mark:
 * this is an ordered LIST, each entry carries its own caption, and the two
 * cannot be expressed by one image without baking the labels into artwork.
 *
 * `logo` is optional on purpose. The design ships letter tiles as placeholders
 * for parties whose artwork has not arrived, so a name alone is a valid entry
 * and renders the initial rather than a broken image.
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
   * Optional "seeded by" mark rendered at the bottom of the sidebar. Absent
   * (null) ⇒ no footer logo — it's opt-in per network/brand via brand.json's
   * `footerLogo` / `footerLogoLight` (light = the dark-mode variant).
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
  // footerLogo does NOT inherit network → brand (unlike favicon/logoShape/copy).
  // The "seeded by" footer mark is a network-DEFAULT thing: a specific brand
  // (e.g. up-gzb, ka-dhwd on blue_dot) shows it only if that brand sets its own
  // footerLogo, otherwise it's hidden — even though the network sets one. Keyed
  // on whether a brand entry exists (a real brand is active) vs the plain
  // network default (no brand entry).
  // `footerAttribution` follows the SAME no-inherit rule, and for a stronger
  // reason: it names who owns and runs THIS deployment. Inheriting it would
  // caption an unrelated brand's sidebar with another party's ownership.
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
