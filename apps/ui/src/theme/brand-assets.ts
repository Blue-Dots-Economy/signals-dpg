/**
 * Maps a network id (e.g. `purple_dot`) to logo URLs under
 * /public/brand/<kebab>/. Variants mirror the keys in `brand.json.logo`:
 * default (light background), withStrapline ("Seeded by …"), light (dark
 * backgrounds), withStraplineLight, and onBrand (hero / coloured backgrounds).
 * Returns null only when no network id is given; the file is not checked for
 * existence.
 */
export type BrandLogoVariant =
  | 'default'
  | 'withStrapline'
  | 'light'
  | 'withStraplineLight'
  | 'onBrand';

const VARIANT_FILE: Record<BrandLogoVariant, string> = {
  default: 'logo.png',
  withStrapline: 'logo-with-strapline.png',
  light: 'logo-light.png',
  withStraplineLight: 'logo-with-strapline-light.png',
  onBrand: 'logo-on-brand.png',
};

function kebabFromNetworkId(networkId: string): string {
  return networkId.replaceAll('_', '-');
}

export function networkLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
): string | null {
  if (!networkId) return null;
  return `/brand/${kebabFromNetworkId(networkId)}/${VARIANT_FILE[variant]}`;
}

export function brandLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
  brandSlug?: string | null,
): string | null {
  if (!networkId) return null;
  const slug = (brandSlug ?? '').trim();
  if (slug && slug !== 'standard') {
    return `/brand/${kebabFromNetworkId(networkId)}/${slug}/${VARIANT_FILE[variant]}`;
  }
  return networkLogoUrl(networkId, variant);
}
